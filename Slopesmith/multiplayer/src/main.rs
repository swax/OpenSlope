use bytes::Bytes;
use futures::io::{BufReader, BufWriter};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Request, Response, StatusCode, body::Incoming, service::service_fn};
use hyper_util::rt::TokioIo;
use slopesmith_multiplayer::{
    protocol::*,
    room::{self, Command, Hub, Outbound, Participant},
    ticket,
};
use soketto::handshake::http::Server;
use std::{
    collections::HashMap,
    convert::Infallible,
    env,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, mpsc, watch};
use tokio_util::{compat::TokioAsyncReadCompatExt, sync::CancellationToken};
mod compression;

type Body = Full<Bytes>;
type Error = Box<dyn std::error::Error + Send + Sync>;
#[derive(Clone)]
struct State {
    hub: Hub,
    site: slopesmith_multiplayer::site::Site,
    secret: Arc<Vec<u8>>,
    slots: Arc<Semaphore>,
    stop: CancellationToken,
    nonces: Arc<Mutex<HashMap<String, f64>>>,
}
fn response(status: StatusCode, body: impl Into<Bytes>) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        // Ordinary HTTP responses must not leave a pooled socket past the connection deadline.
        // WebSocket upgrades bypass this helper and must retain only Connection: Upgrade.
        .header("connection", "close")
        .body(Full::new(body.into()))
        .unwrap()
}
fn number(name: &str, default: usize, max: usize) -> Result<usize, Error> {
    let n = env::var(name)
        .ok()
        .map(|n| n.parse::<usize>())
        .transpose()?
        .unwrap_or(default);
    if n == 0 || n > max {
        return Err(format!("{name} must be between 1 and {max}").into());
    }
    Ok(n)
}
#[tokio::main]
async fn main() -> Result<(), Error> {
    let secret = env::var("SLOPESMITH_MULTIPLAYER_SECRET")
        .map_err(|_| "SLOPESMITH_MULTIPLAYER_SECRET is required")?;
    if secret.len() < 32 {
        return Err("SLOPESMITH_MULTIPLAYER_SECRET must contain at least 32 bytes".into());
    }
    let address: SocketAddr = env::var("SLOPESMITH_MULTIPLAYER_BIND")
        .unwrap_or_else(|_| "127.0.0.1:5181".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    let state = State {
        site: Default::default(),
        hub: Hub::new(number("SLOPESMITH_MULTIPLAYER_ROOM_PLAYERS", 32, 512)?),
        secret: Arc::new(secret.into_bytes()),
        slots: Arc::new(Semaphore::new(number(
            "SLOPESMITH_MULTIPLAYER_MAX_CONNECTIONS",
            1000,
            100_000,
        )?)),
        stop: CancellationToken::new(),
        nonces: Arc::default(),
    };
    println!("multiplayer listening on {}", listener.local_addr()?);
    let stop = state.stop.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        stop.cancel();
    });
    loop {
        tokio::select! {
            _ = state.stop.cancelled() => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted?; stream.set_nodelay(true)?;
                // Include unauthenticated HTTP/upgrade sockets in the process-wide bound.
                let Ok(slot) = state.slots.clone().try_acquire_owned() else { continue; };
                let state = state.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |request| handle(request, state.clone()));
                    let connection = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades();
                    let _ = tokio::time::timeout(Duration::from_secs(10), connection).await;
                    drop(slot);
                });
            }
        }
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
    Ok(())
}
async fn handle(req: Request<Incoming>, state: State) -> Result<Response<Body>, Infallible> {
    if req.uri().path() == "/health" && req.method() == hyper::Method::GET {
        return Ok(response(StatusCode::OK, "{\"ok\":true,\"protocol\":1}"));
    }
    if (req.uri().path() == "/control" && req.method() == hyper::Method::POST)
        || (req.uri().path() == "/site" && req.method() == hyper::Method::GET)
    {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        // Compare a keyed digest rather than a secret-dependent string equality.
        let supplied = req
            .headers()
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        let expected = format!("Bearer {}", String::from_utf8_lossy(&state.secret));
        let mut a = Hmac::<Sha256>::new_from_slice(&state.secret).unwrap();
        a.update(supplied.as_bytes());
        let mut b = Hmac::<Sha256>::new_from_slice(&state.secret).unwrap();
        b.update(expected.as_bytes());
        if b.verify_slice(&a.finalize().into_bytes()).is_err() {
            return Ok(response(StatusCode::FORBIDDEN, "{\"error\":\"forbidden\"}"));
        }
        if req.uri().path() == "/site" {
            return Ok(response(
                StatusCode::OK,
                state
                    .site
                    .snapshot(req.uri().query() != Some("public=1"))
                    .to_string(),
            ));
        }
        let body = Limited::new(req.into_body(), 4096).collect().await;
        if let Ok(body) = body
            && let Ok(message) = serde_json::from_slice::<PlayControlMessage>(&body.to_bytes())
        {
            state.site.control(&message);
            state.hub.control(message).await;
            return Ok(response(StatusCode::OK, "{\"ok\":true}"));
        }
        return Ok(response(
            StatusCode::BAD_REQUEST,
            "{\"error\":\"invalid control message\"}",
        ));
    }
    if req.uri().path() != "/api/play/session"
        || !soketto::handshake::http::is_upgrade_request(&req)
    {
        return Ok(response(StatusCode::NOT_FOUND, "{\"error\":\"not found\"}"));
    }
    let origin = req
        .headers()
        .get("origin")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_owned();
    if origin.len() > 512 || !(origin.starts_with("https://") || origin.starts_with("http://")) {
        return Ok(response(
            StatusCode::FORBIDDEN,
            "{\"error\":\"origin required\"}",
        ));
    }
    let Ok(slot) = state.slots.clone().try_acquire_owned() else {
        return Ok(response(
            StatusCode::SERVICE_UNAVAILABLE,
            "{\"error\":\"server full\"}",
        ));
    };
    let mut handshake = Server::new();
    handshake.add_extension(Box::new(compression::BoundedDeflate::new()));
    match handshake.receive_request(&req) {
        Ok(upgrade) => {
            tokio::spawn(async move {
                let _ = connection(handshake, req, state, origin).await;
                drop(slot);
            });
            Ok(upgrade.map(|()| Full::default()))
        }
        Err(_) => Ok(response(
            StatusCode::BAD_REQUEST,
            "{\"error\":\"invalid upgrade\"}",
        )),
    }
}

async fn connection(
    handshake: Server,
    req: Request<Incoming>,
    state: State,
    origin: String,
) -> Result<(), Error> {
    let upgraded = tokio::time::timeout(Duration::from_secs(5), hyper::upgrade::on(req)).await??;
    let io = BufReader::new(BufWriter::new(TokioIo::new(upgraded).compat()));
    let mut builder = handshake.into_builder(io);
    builder.set_max_message_size(16 * 1024);
    builder.set_max_frame_size(16 * 1024);
    let (mut sender, mut receiver) = builder.finish();
    let cancel = state.stop.child_token();
    let (incoming, mut messages) = mpsc::channel(8);
    let reader_cancel = cancel.clone();
    let reader = tokio::spawn(async move {
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match receiver.receive_data(&mut bytes).await {
                Ok(soketto::Data::Text(_)) => {}
                Err(soketto::connection::Error::Closed | soketto::connection::Error::Io(_)) => {
                    break;
                }
                Err(error) => {
                    eprintln!("multiplayer receive failed: {error}");
                    break;
                }
                _ => break,
            }
            let Ok(message) = serde_json::from_slice::<PlayClientMessage>(&bytes) else {
                eprintln!("multiplayer received an invalid message");
                break;
            };
            if incoming.send(message).await.is_err() {
                break;
            }
        }
        reader_cancel.cancel();
    });
    let (outgoing, mut reliable) = mpsc::channel::<Outbound>(32);
    let (latest, mut poses) = watch::channel::<Option<Arc<str>>>(None);
    let writer_cancel = cancel.clone();
    let writer = tokio::spawn(async move {
        loop {
            let next = tokio::select! {
                biased;
                _ = writer_cancel.cancelled() => Some(Outbound::Close(1012, "Multiplayer is reconnecting.")),
                value = reliable.recv() => value,
                value = poses.changed() => if value.is_ok() { poses.borrow_and_update().clone().map(Outbound::Text) } else { None },
            };
            let Some(next) = next else {
                break;
            };
            match next {
                Outbound::Close(code, reason) => {
                    let _ = tokio::time::timeout(Duration::from_secs(2), async {
                        sender
                            .send_text(
                                serde_json::to_string(&PlayServerMessage::Closed {
                                    code,
                                    reason: reason.into(),
                                })
                                .unwrap(),
                            )
                            .await?;
                        sender.flush().await?;
                        sender.close().await
                    })
                    .await;
                    break;
                }
                Outbound::Text(value) => {
                    let sent = tokio::time::timeout(Duration::from_secs(5), async {
                        sender.send_text(&value).await?;
                        sender.flush().await
                    })
                    .await;
                    if !matches!(sent, Ok(Ok(()))) {
                        break;
                    }
                }
            }
        }
        writer_cancel.cancel();
    });
    let hello = tokio::time::timeout(Duration::from_secs(5), messages.recv()).await;
    let claims = if let Ok(Some(PlayClientMessage::Hello {
        protocol: PROTOCOL_VERSION,
        ticket: encoded,
    })) = hello
    {
        ticket::verify(&encoded, &state.secret, &origin, room::now())
    } else {
        None
    };
    let Some(mut claims) = claims else {
        let _ = outgoing
            .send(Outbound::Close(4001, "A valid play ticket is required."))
            .await;
        let _ = writer.await;
        reader.abort();
        return Ok(());
    };
    let used = {
        let mut nonces = state.nonces.lock().unwrap();
        let now = room::now();
        nonces.retain(|_, expiry| *expiry > now);
        nonces
            .insert(claims.nonce.clone(), claims.expires_at)
            .is_some()
    };
    if used {
        cancel.cancel();
        let _ = writer.await;
        reader.abort();
        return Ok(());
    }
    if claims.site_presence == Some(true) {
        let id = claims.session_id.clone();
        let mut updates = state.site.subscribe();
        if !state
            .site
            .join(claims.clone(), outgoing.clone(), cancel.clone())
        {
            let _ = outgoing
                .send(Outbound::Close(
                    4001,
                    "This site session is already connected.",
                ))
                .await;
            let _ = writer.await;
            reader.abort();
            return Ok(());
        }
        let _ = outgoing
            .send(room::text(&PlayServerMessage::Welcome {
                protocol: PROTOCOL_VERSION,
                session_id: id.clone(),
                member: claims.member.clone(),
                color: claims.color.clone(),
                server_time: room::now(),
                course_id: claims.course_id.clone(),
                room_id: claims.room_id.clone(),
                publish_ms: 1000,
            }))
            .await;
        let mut roster = false;
        let _ = latest.send(Some(updates.borrow().message(!claims.public_play, roster)));
        let mut sweep = tokio::time::interval(Duration::from_secs(1));
        let mut active = Instant::now();
        let mut tokens = 20f64;
        let mut bucket_at = Instant::now();
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                result = updates.changed() => {
                    if result.is_err() { break; }
                    let snapshot = updates.borrow_and_update();
                    let _ = latest.send(Some(snapshot.message(!claims.public_play, roster)));
                }
                _ = sweep.tick() => {
                    if room::now() >= claims.expires_at || active.elapsed() > Duration::from_secs(150) { break; }
                }
                message = messages.recv() => {
                    let elapsed = bucket_at.elapsed().as_secs_f64(); bucket_at = Instant::now();
                    tokens = (tokens + elapsed * 5.).min(20.);
                    if tokens < 1. { break; } tokens -= 1.; active = Instant::now();
                    match message {
                        Some(PlayClientMessage::SiteRoster { enabled }) => {
                            roster = enabled;
                            let _ = latest.send(Some(updates.borrow().message(!claims.public_play, roster)));
                        }
                        Some(PlayClientMessage::Ping { at }) if at.is_finite() => {
                            let _ = outgoing.send(room::text(&PlayServerMessage::Pong { echo: at, server_time: room::now() })).await;
                        }
                        Some(PlayClientMessage::Renew { ticket: encoded }) => {
                            let Some(fresh) = ticket::verify(&encoded, &state.secret, &origin, room::now()) else { break; };
                            if fresh.site_presence != Some(true) || fresh.session_id != claims.session_id || fresh.member.id != claims.member.id || fresh.public_play != claims.public_play || fresh.account_session_id != claims.account_session_id { break; }
                            claims = fresh;
                            state.site.renew(claims.clone());
                        }
                        _ => break,
                    }
                }
            }
        }
        state.site.leave(&id);
        reader.abort();
        drop(outgoing);
        drop(latest);
        let _ = writer.await;
        return Ok(());
    }
    let id = claims.session_id.clone();
    let Some(room) = state
        .hub
        .join(Participant::new(
            claims.clone(),
            outgoing.clone(),
            latest,
            cancel.clone(),
        ))
        .await
    else {
        drop(outgoing);
        let _ = writer.await;
        reader.abort();
        return Ok(());
    };
    let mut sweep = tokio::time::interval(Duration::from_secs(1));
    let mut active = Instant::now();
    let mut tokens = 240f64;
    let mut event_tokens = 24f64;
    let mut bucket_at = Instant::now();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = sweep.tick() => {
                if room::now() >= claims.expires_at || active.elapsed() > Duration::from_secs(45) {
                    let _ = outgoing.send(Outbound::Close(4001, "Play admission expired; reconnect to refresh.")).await; break;
                }
            }
            message = messages.recv() => {
                let Some(message) = message else { break; };
                let elapsed = bucket_at.elapsed().as_secs_f64(); bucket_at = Instant::now();
                tokens = (tokens + elapsed * 120.).min(240.); event_tokens = (event_tokens + elapsed * 12.).min(24.);
                if tokens < 1. { break; } tokens -= 1.; active = Instant::now();
                match message {
                    PlayClientMessage::Renew { ticket: encoded } => {
                        let Some(fresh) = ticket::verify(&encoded, &state.secret, &origin, room::now()) else { break; };
                        if fresh.session_id != claims.session_id || fresh.member.id != claims.member.id || fresh.course_id != claims.course_id
                            || fresh.room_id != claims.room_id || fresh.public_play != claims.public_play || fresh.account_session_id != claims.account_session_id { break; }
                        claims = fresh;
                        if room.send(Command::Renew(Box::new(claims.clone()))).await.is_err() { break; }
                    }
                    PlayClientMessage::Hello { .. } => break,
                    PlayClientMessage::RideEvent { .. } if event_tokens < 1. => break,
                    other => {
                        if matches!(other, PlayClientMessage::RideEvent { .. }) { event_tokens -= 1.; }
                        if room.send(Command::Message(id.clone(), other)).await.is_err() { break; }
                    }
                }
            }
        }
    }
    // Remove membership before closing the socket; editors never participate in this lifecycle.
    let _ = room.send(Command::Leave(id)).await;
    reader.abort();
    drop(outgoing);
    let _ = writer.await;
    Ok(())
}

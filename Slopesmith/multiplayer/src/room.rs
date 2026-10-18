//! One actor per play room. Reliable messages have bounded queues; poses use replaceable full snapshots.
use crate::{protocol::*, validation};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

pub fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.
}
pub enum Outbound {
    Text(Arc<str>),
    Close(u16, &'static str),
}
pub fn text(message: &PlayServerMessage) -> Outbound {
    Outbound::Text(serde_json::to_string(message).unwrap().into())
}

pub struct Participant {
    pub claims: TicketClaims,
    pub send: mpsc::Sender<Outbound>,
    pub poses: watch::Sender<Option<Arc<str>>>,
    pub cancel: CancellationToken,
    pose: Option<PlayerPose>,
    last_event: Option<u32>,
}
impl Participant {
    pub fn new(
        claims: TicketClaims,
        send: mpsc::Sender<Outbound>,
        poses: watch::Sender<Option<Arc<str>>>,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            claims,
            send,
            poses,
            cancel,
            pose: None,
            last_event: None,
        }
    }
    fn peer(&self) -> PlayPeer {
        PlayPeer {
            session_id: self.claims.session_id.clone(),
            client_id: self.claims.client_id.clone(),
            device_label: self.claims.device_label.clone(),
            member: self.claims.member.clone(),
            color: self.claims.color.clone(),
        }
    }
    fn reliable(&self, value: Outbound) {
        if self.send.try_send(value).is_err() {
            self.cancel.cancel();
        }
    }
}

pub enum Command {
    Join(Box<Participant>, oneshot::Sender<bool>),
    Leave(String),
    Message(String, PlayClientMessage),
    Control(PlayControlMessage),
    Renew(Box<TicketClaims>),
}
type RoomKey = (String, String);
#[derive(Clone)]
pub struct Hub {
    rooms: Arc<Mutex<HashMap<RoomKey, mpsc::Sender<Command>>>>,
    capacity: usize,
}
impl Hub {
    pub fn new(capacity: usize) -> Self {
        Self {
            rooms: Arc::default(),
            capacity,
        }
    }
    pub async fn join(&self, participant: Participant) -> Option<mpsc::Sender<Command>> {
        let key = (
            participant.claims.course_id.clone(),
            participant.claims.room_id.clone(),
        );
        let sender = {
            let mut rooms = self.rooms.lock().unwrap();
            rooms.retain(|_, room| !room.is_closed());
            if rooms.get(&key).is_some_and(mpsc::Sender::is_closed) {
                rooms.remove(&key);
            }
            rooms
                .entry(key.clone())
                .or_insert_with(|| {
                    let (send, recv) = mpsc::channel(256);
                    tokio::spawn(run(key, recv, self.capacity));
                    send
                })
                .clone()
        };
        let (answer, receive) = oneshot::channel();
        sender
            .send(Command::Join(Box::new(participant), answer))
            .await
            .ok()?;
        receive.await.ok()?.then_some(sender)
    }
    pub async fn control(&self, message: PlayControlMessage) {
        let rooms: Vec<_> = self.rooms.lock().unwrap().values().cloned().collect();
        for room in rooms {
            let _ = room.send(Command::Control(message.clone())).await;
        }
    }
}
fn broadcast(
    peers: &HashMap<String, Participant>,
    message: &PlayServerMessage,
    except: Option<&str>,
) {
    let value: Arc<str> = serde_json::to_string(message).unwrap().into();
    for (id, peer) in peers {
        if Some(id.as_str()) != except {
            peer.reliable(Outbound::Text(value.clone()));
        }
    }
}
fn presence(course: &str, peers: &HashMap<String, Participant>) {
    broadcast(
        peers,
        &PlayServerMessage::Presence {
            course_id: course.into(),
            peers: peers.values().map(Participant::peer).collect(),
        },
        None,
    );
}
async fn run(key: RoomKey, mut commands: mpsc::Receiver<Command>, capacity: usize) {
    let mut peers = HashMap::<String, Participant>::new();
    let mut dirty = false;
    let mut empty_since = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(80));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                None => break,
                Some(Command::Join(peer, answer)) => {
                    let peer = *peer;
                    if peers.len() >= capacity || peers.contains_key(&peer.claims.session_id) {
                        peer.reliable(Outbound::Close(4003, "This play room is full.")); let _ = answer.send(false); continue;
                    }
                    let id = peer.claims.session_id.clone();
                    peer.reliable(text(&PlayServerMessage::Welcome { protocol: PROTOCOL_VERSION, session_id: id.clone(),
                        member: peer.claims.member.clone(), color: peer.claims.color.clone(), server_time: now(), course_id: key.0.clone(), room_id: key.1.clone(), publish_ms: 80 }));
                    peer.reliable(text(&PlayServerMessage::ChatHistory { lines: Vec::new() }));
                    peers.insert(id, peer); presence(&key.0, &peers); dirty = true;
                    let _ = answer.send(true);
                }
                Some(Command::Leave(id)) => {
                    peers.remove(&id); presence(&key.0, &peers); dirty = true;
                    if peers.is_empty() { empty_since = Instant::now(); }
                }
                Some(Command::Control(control)) => {
                    for peer in peers.values() {
                        let affected = match &control {
                            PlayControlMessage::RevokeUser { user_id } => peer.claims.member.id == *user_id,
                            PlayControlMessage::RevokeSession { account_session_id } => peer.claims.account_session_id.as_ref() == Some(account_session_id),
                            PlayControlMessage::RemoveCourse { course_id } => peer.claims.public_play && key.0 == *course_id,
                        };
                        if affected { peer.reliable(Outbound::Close(4001, "Play access changed; reconnect to refresh.")); }
                    }
                }
                Some(Command::Renew(claims)) => {
                    if let Some(peer) = peers.get_mut(&claims.session_id) { peer.claims = *claims; }
                    presence(&key.0, &peers);
                }
                Some(Command::Message(id, message)) => {
                    let Some(peer) = peers.get_mut(&id) else { continue; };
                    match message {
                        PlayClientMessage::Pose { player } => {
                            let Some(player) = player else {
                                dirty |= peer.pose.take().is_some();
                                continue;
                            };
                            if peer.pose.as_ref().is_some_and(|old| player.seq <= old.seq) { continue; }
                            if let Some(clean) = validation::pose(*player, now()) { peer.pose = Some(clean); dirty = true; }
                        }
                        PlayClientMessage::RideEvent { event } => {
                            if peer.last_event.is_some_and(|last| event.id <= last) { continue; }
                            if let Some(event) = validation::ride_event(event, &key.0, now()) {
                                peer.last_event = Some(event.id);
                                broadcast(&peers, &PlayServerMessage::RideEvent { course_id: key.0.clone(), from_session_id: id.clone(), server_at: now(), event }, Some(&id));
                            }
                        }
                        PlayClientMessage::Chat { .. } => {} // Community chat is handled and moderated by Node.
                        PlayClientMessage::Ping { at } if at.is_finite() => peer.reliable(text(&PlayServerMessage::Pong { echo: at, server_time: now() })),
                        _ => {}
                    }
                }
            },
            _ = tick.tick() => {
                if peers.is_empty() && empty_since.elapsed() > Duration::from_secs(30) { break; }
                if !dirty { continue; }
                dirty = false;
                let message = PlayServerMessage::Poses { course_id: key.0.clone(), peers: peers.iter().filter_map(|(id,p)| p.pose.clone().map(|player| PeerPose { session_id: id.clone(), player })).collect() };
                let encoded: Arc<str> = serde_json::to_string(&message).unwrap().into();
                // Each update is the entire latest snapshot. Replacing a pending snapshot cannot lose another rider.
                for peer in peers.values() { peer.poses.send_replace(Some(encoded.clone())); }
            }
        }
    }
}

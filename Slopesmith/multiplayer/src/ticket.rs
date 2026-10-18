use crate::protocol::{PROTOCOL_VERSION, TicketClaims};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub fn verify(ticket: &str, secret: &[u8], origin: &str, now: f64) -> Option<TicketClaims> {
    if ticket.len() > 8192 {
        return None;
    }
    let (payload, signature) = ticket.split_once('.')?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(signature).ok()?)
        .ok()?;
    let claims: TicketClaims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    if claims.protocol != PROTOCOL_VERSION
        || claims.origin != origin
        || !claims.expires_at.is_finite()
        || claims.expires_at <= now
        || claims.expires_at
            > now
                + if claims.site_presence == Some(true) {
                    305_000.
                } else {
                    65_000.
                }
        || claims.session_id.is_empty()
        || claims.course_id.is_empty()
        || claims.course_id.len() > 160
        || claims.room_id.is_empty()
        || claims.room_id.len() > 64
        || claims.nonce.is_empty()
    {
        return None;
    }
    Some(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_tampering_expiry_and_wrong_origin() {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({"protocol":1,"nonce":"a","expiresAt":1000,"sessionId":"s","clientId":"c","deviceLabel":"d","member":{"id":"u","username":"U","role":"viewer"},"color":"#fff","courseId":"map","roomId":"lodge","publicPlay":true,"origin":"https://example.com"})).unwrap());
        let mut mac = Hmac::<Sha256>::new_from_slice(b"secret").unwrap();
        mac.update(payload.as_bytes());
        let ticket = format!(
            "{payload}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        );
        assert!(verify(&ticket, b"secret", "https://example.com", 0.).is_some());
        assert!(verify(&ticket, b"wrong", "https://example.com", 0.).is_none());
        assert!(verify(&ticket, b"secret", "https://evil.example", 0.).is_none());
        assert!(verify(&ticket, b"secret", "https://example.com", 1000.).is_none());
    }
}

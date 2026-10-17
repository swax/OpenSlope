use crate::protocol::*;

fn vector(value: &[f64], bound: f64) -> bool {
    value.iter().all(|n| n.is_finite() && n.abs() <= bound)
}
fn normalize(value: &mut [f64], bound: f64) -> bool {
    if !vector(value, bound) {
        return false;
    }
    let length = value.iter().map(|n| n * n).sum::<f64>().sqrt();
    if length < 1e-5 {
        return false;
    }
    value.iter_mut().for_each(|n| *n /= length);
    true
}
fn transform(value: &mut PlayerTransform) -> bool {
    vector(&value.p, 1_000_000.) && normalize(&mut value.q, 2.)
}
fn gesture(value: &mut PlayerPointGesture) -> bool {
    normalize(&mut value.direction, 1.)
        && value.target.as_ref().is_none_or(|v| vector(v, 1_000_000.))
}
pub fn pose(mut value: PlayerPose, now: f64) -> Option<PlayerPose> {
    if value.version != 2
        || !transform(&mut value.body)
        || !vector(&value.velocity, 500.)
        || value.avatar.is_empty()
        || value.avatar.len() > 150
        || value
            .avatar
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return None;
    }
    if !value.sample_at.is_finite() || (value.sample_at - now).abs() > 30_000. {
        value.sample_at = now;
    }
    if let Some(head) = &mut value.head
        && !transform(head)
    {
        return None;
    }
    if let Some(hands) = &mut value.hands {
        for hand in hands.iter_mut().flatten() {
            if !transform(hand) {
                return None;
            }
        }
    }
    if let Some(a) = &mut value.animation {
        if !vector(&[a.crouch, a.lean], 2.)
            || !vector(&[a.bank], 360.)
            || a.lead.is_some_and(|n| n != 1 && n != -1)
        {
            return None;
        }
        a.crouch = a.crouch.clamp(-1., 1.);
        a.lean = a.lean.clamp(-1., 1.);
    }
    if let Some(g) = &mut value.gesture
        && !gesture(g)
    {
        return None;
    }
    if let Some(gs) = &mut value.gestures
        && (gs.len() > 2
            || (gs.len() == 2 && gs[0].hand == gs[1].hand)
            || !gs.iter_mut().all(gesture))
    {
        return None;
    }
    if let Some(e) = &mut value.equipment
        && (!transform(&mut e.transform) || !vector(&e.velocity, 500.))
    {
        return None;
    }
    let mounted = value
        .equipment
        .as_ref()
        .is_some_and(|e| e.state == PlayerEquipmentState::Mounted);
    if (value.mode == PlayerMode::Ride) != mounted
        || (value.mode == PlayerMode::Edit && value.equipment.is_some())
    {
        return None;
    }
    Some(value)
}
pub fn ride_event(mut value: RideEventMessage, course: &str, now: f64) -> Option<RideEventMessage> {
    let matches = match &value.target {
        RideEventTarget::Authored => !course.starts_with("@reference:"),
        RideEventTarget::Reference { level } => {
            course == format!("@reference:{}", level.to_uppercase())
        }
    };
    if !matches
        || value.key.is_empty()
        || value.key.len() > 512
        || value.key.chars().any(char::is_control)
        || !value.rider_speed.is_finite()
        || !(0. ..=500.).contains(&value.rider_speed)
        || !value.sent_at.is_finite()
    {
        return None;
    }
    // Old one-shots are discarded, never refreshed into a new run.
    if value.sent_at < now - 10_000. || value.sent_at > now + 30_000. {
        return None;
    }
    if let Some(c) = &mut value.contact {
        let length = c.normal.iter().map(|n| n * n).sum::<f64>().sqrt();
        if value.kind != RideEventKind::Collision
            || !vector(&c.point, 1_000_000.)
            || !(0.5..=1.5).contains(&length)
            || !normalize(&mut c.normal, 1.001)
        {
            return None;
        }
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_typescript_rust_fixtures() {
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/play-protocol-v1.json")).unwrap();
        for raw in corpus["valid"].as_array().unwrap() {
            let message: PlayClientMessage = serde_json::from_value(raw.clone()).unwrap();
            match message {
                PlayClientMessage::Pose {
                    player: Some(player),
                } => assert!(pose(*player, 1000.).is_some()),
                PlayClientMessage::RideEvent { event } => {
                    assert!(ride_event(event, "fixture", 1000.).is_some())
                }
                _ => {}
            }
        }
        for raw in corpus["invalid"].as_array().unwrap() {
            assert!(serde_json::from_value::<PlayClientMessage>(raw.clone()).is_err());
        }
    }
    #[test]
    fn fixtures_are_validated_and_normalized() {
        let raw = serde_json::json!({"version":2,"seq":1,"sampleAt":0,"teleport":0,"mode":"edit","vr":false,"avatar":"procedural","body":{"p":[0,0,0],"q":[0,0,0,2]},"velocity":[0,0,0]});
        let clean = pose(serde_json::from_value(raw.clone()).unwrap(), 100.).unwrap();
        assert_eq!(clean.body.q, [0., 0., 0., 1.]);
        let mut broken = raw;
        broken["velocity"] = serde_json::json!([501, 0, 0]);
        assert!(pose(serde_json::from_value(broken).unwrap(), 100.).is_none());
    }
}

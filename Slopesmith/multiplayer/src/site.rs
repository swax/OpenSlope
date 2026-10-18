//! Low-rate site presence is independent of movement rooms and chat participation.
use crate::{protocol::*, room::Outbound};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

struct Visitor {
    claims: TicketClaims,
    send: mpsc::Sender<Outbound>,
    cancel: CancellationToken,
}
#[derive(Clone)]
pub struct Snapshots {
    pub public: Arc<str>,
    pub members: Arc<str>,
    pub public_counts: Arc<str>,
    pub member_counts: Arc<str>,
}
impl Snapshots {
    pub fn message(&self, private: bool, roster: bool) -> Arc<str> {
        match (private, roster) {
            (true, true) => self.members.clone(),
            (false, true) => self.public.clone(),
            (true, false) => self.member_counts.clone(),
            (false, false) => self.public_counts.clone(),
        }
    }
}
#[derive(Clone)]
pub struct Site {
    visitors: Arc<Mutex<HashMap<String, Visitor>>>,
    updates: watch::Sender<Snapshots>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn claims(user: &str, session: &str, map: Option<(&str, bool)>) -> TicketClaims {
        serde_json::from_value(serde_json::json!({
            "protocol":1,"nonce":session,"expiresAt":1000,"sessionId":session,"clientId":session,"deviceLabel":"test",
            "member":{"id":user,"username":user,"role":"viewer","anonymous":true,"chatId":"same-network"},
            "color":"#fff","courseId":map.map(|m|m.0).unwrap_or("@site"),"roomId":"site","publicPlay":true,
            "sitePresence":true,"origin":"http://localhost",
            "siteCourse":map.map(|(id,public)|serde_json::json!({"id":id,"name":id,"playUrl":if public {Some(format!("/play/{id}"))} else {None}}))
        })).unwrap()
    }
    fn add(site: &Site, user: &str, session: &str, map: Option<(&str, bool)>) {
        let (sender, _) = mpsc::channel(8);
        site.join(claims(user, session, map), sender, CancellationToken::new());
    }
    #[test]
    fn counts_people_and_open_maps_independently_of_chat_and_poses() {
        let site = Site::default();
        add(&site, "guest:a", "tab-a", Some(("mountain", true)));
        add(&site, "guest:a", "tab-b", Some(("mountain", true)));
        add(&site, "guest:b", "tab-c", None);
        let value: serde_json::Value = serde_json::from_str(&site.snapshot(false)).unwrap();
        assert_eq!(value["online"], 2);
        assert_eq!(value["courses"]["mountain"], 1);
        site.leave("tab-a");
        let value: serde_json::Value = serde_json::from_str(&site.snapshot(false)).unwrap();
        assert_eq!(value["courses"]["mountain"], 1);
        site.leave("tab-b");
        let value: serde_json::Value = serde_json::from_str(&site.snapshot(false)).unwrap();
        assert_eq!(value["online"], 1);
        assert!(value["courses"].as_object().unwrap().is_empty());
    }
    #[test]
    fn private_map_metadata_is_not_published_to_anonymous_visitors() {
        let site = Site::default();
        add(&site, "member", "tab", Some(("private-mountain", false)));
        assert!(!site.snapshot(false).contains("private-mountain"));
        assert!(site.snapshot(true).contains("private-mountain"));
        let value: serde_json::Value = serde_json::from_str(&site.snapshot(false)).unwrap();
        assert_eq!(value["online"], 1);
    }
    #[test]
    fn preserves_map_sources_and_rooms_without_counting_one_person_twice() {
        let site = Site::default();
        for (session, source, room) in [
            ("iso", MapSource::Iso, "lodge"),
            ("server", MapSource::Server, "lodge"),
            ("invite", MapSource::Iso, "friends"),
        ] {
            let mut ticket = claims("guest:a", session, Some(("@reference:GARI", true)));
            let map = ticket.site_course.as_mut().unwrap();
            map.source = Some(source);
            map.room_id = Some(room.into());
            let (sender, _) = mpsc::channel(8);
            site.join(ticket, sender, CancellationToken::new());
        }
        let value: serde_json::Value = serde_json::from_str(&site.snapshot(false)).unwrap();
        assert_eq!(value["online"], 1);
        assert_eq!(value["courses"]["@reference:GARI"], 1);
        let maps = value["members"][0]["maps"].as_array().unwrap();
        assert_eq!(maps.len(), 3);
        assert!(
            maps.iter()
                .any(|map| map["source"] == "iso" && map["roomId"] == "friends")
        );
        assert!(
            maps.iter()
                .any(|map| map["source"] == "server" && map["roomId"] == "lodge")
        );
    }
}
impl Default for Site {
    fn default() -> Self {
        let empty: Arc<str> = serde_json::to_string(&PlayServerMessage::SitePresence {
            online: 0,
            courses: BTreeMap::new(),
            members: vec![],
        })
        .unwrap()
        .into();
        let counts: Arc<str> = serde_json::to_string(&PlayServerMessage::SiteActivity {
            online: 0,
            courses: BTreeMap::new(),
        })
        .unwrap()
        .into();
        let (updates, _) = watch::channel(Snapshots {
            public: empty.clone(),
            members: empty,
            public_counts: counts.clone(),
            member_counts: counts,
        });
        Self {
            visitors: Arc::default(),
            updates,
        }
    }
}
impl Site {
    pub fn subscribe(&self) -> watch::Receiver<Snapshots> {
        self.updates.subscribe()
    }
    pub fn snapshot(&self, private: bool) -> Arc<str> {
        let current = self.updates.borrow();
        if private {
            current.members.clone()
        } else {
            current.public.clone()
        }
    }
    pub fn join(
        &self,
        claims: TicketClaims,
        send: mpsc::Sender<Outbound>,
        cancel: CancellationToken,
    ) -> bool {
        let mut visitors = self.visitors.lock().unwrap();
        if visitors.contains_key(&claims.session_id) {
            return false;
        }
        visitors.insert(
            claims.session_id.clone(),
            Visitor {
                claims,
                send,
                cancel,
            },
        );
        self.publish(&visitors);
        true
    }
    pub fn renew(&self, claims: TicketClaims) {
        let mut visitors = self.visitors.lock().unwrap();
        if let Some(visitor) = visitors.get_mut(&claims.session_id) {
            let moved = visitor.claims.course_id != claims.course_id
                || visitor.claims.member.username != claims.member.username
                || visitor.claims.member.role != claims.member.role
                || visitor.claims.member.chat_id != claims.member.chat_id
                || serde_json::to_string(&visitor.claims.site_course).ok()
                    != serde_json::to_string(&claims.site_course).ok();
            visitor.claims = claims;
            if moved {
                self.publish(&visitors);
            }
        }
    }
    pub fn leave(&self, id: &str) {
        let mut visitors = self.visitors.lock().unwrap();
        visitors.remove(id);
        self.publish(&visitors);
    }
    pub fn control(&self, message: &PlayControlMessage) {
        let visitors = self.visitors.lock().unwrap();
        for visitor in visitors.values() {
            let affected = match message {
                PlayControlMessage::RevokeUser { user_id } => visitor.claims.member.id == *user_id,
                PlayControlMessage::RevokeSession { account_session_id } => {
                    visitor.claims.account_session_id.as_ref() == Some(account_session_id)
                }
                PlayControlMessage::RemoveCourse { course_id } => {
                    visitor.claims.public_play && visitor.claims.course_id == *course_id
                }
            };
            if affected
                && visitor
                    .send
                    .try_send(Outbound::Close(
                        4001,
                        "Site access changed; reconnect to refresh.",
                    ))
                    .is_err()
            {
                visitor.cancel.cancel();
            }
        }
    }
    fn publish(&self, visitors: &HashMap<String, Visitor>) {
        let render = |private: bool| -> Arc<str> {
            type MapKey = (String, Option<MapSource>, Option<String>);
            let mut users = BTreeMap::<String, (PlayMember, BTreeMap<MapKey, SiteCourse>)>::new();
            for visitor in visitors.values() {
                let claims = &visitor.claims;
                let user = users
                    .entry(claims.member.id.clone())
                    .or_insert_with(|| (claims.member.clone(), BTreeMap::new()));
                if user.0.anonymous == Some(true) && claims.member.anonymous != Some(true) {
                    user.0 = claims.member.clone();
                }
                if let Some(course) = &claims.site_course {
                    if private || course.play_url.is_some() {
                        user.1.insert(
                            (course.id.clone(), course.source, course.room_id.clone()),
                            course.clone(),
                        );
                    }
                }
            }
            let mut courses = BTreeMap::<String, u32>::new();
            let members: Vec<_> = users
                .into_values()
                .map(|(member, maps)| {
                    let ids: BTreeSet<_> = maps.values().map(|map| map.id.clone()).collect();
                    for id in ids {
                        *courses.entry(id).or_default() += 1;
                    }
                    SiteMember {
                        member,
                        maps: maps.into_values().collect(),
                    }
                })
                .collect();
            serde_json::to_string(&PlayServerMessage::SitePresence {
                online: members.len() as u32,
                courses,
                members,
            })
            .unwrap()
            .into()
        };
        let public = render(false);
        let members = render(true);
        let counts = |full: &str| -> Arc<str> {
            let full: PlayServerMessage = serde_json::from_str(full).unwrap();
            if let PlayServerMessage::SitePresence {
                online, courses, ..
            } = full
            {
                serde_json::to_string(&PlayServerMessage::SiteActivity { online, courses })
                    .unwrap()
                    .into()
            } else {
                unreachable!()
            }
        };
        let public_counts = counts(&public);
        let member_counts = counts(&members);
        self.updates.send_replace(Snapshots {
            public,
            members,
            public_counts,
            member_counts,
        });
    }
}

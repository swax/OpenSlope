//! The wire contract. Generated TypeScript and JSON schemas are checked into the repository.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const PROTOCOL_VERSION: u8 = 1;

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
        pub enum $name { $(#[serde(rename = $wire)] $variant),+ }
    };
}
string_enum!(PlayerMode { Edit => "edit", Walk => "walk", Ride => "ride" });
string_enum!(PlayerGear { Snowboard => "snowboard", Skis => "skis" });
string_enum!(PlayerSnowboardStance { Standard => "standard", Goofy => "goofy" });
string_enum!(PlayerEquipmentState { Mounted => "mounted", Loose => "loose", Held => "held" });
string_enum!(Hand { Left => "left", Right => "right" });
string_enum!(PointKind { Point => "point" });
string_enum!(MemberRole { Admin => "admin", Moderator => "moderator", Editor => "editor", Viewer => "viewer" });
string_enum!(RaceMode { Race => "race", Showoff => "showoff", Freeride => "freeride" });
string_enum!(RideEventKind { Collision => "collision", Trigger => "trigger", Cracked => "cracked", CrackedHeal => "cracked-heal", CrackedBreak => "cracked-break" });

pub type PlayerVec3 = [f64; 3];
pub type PlayerQuat = [f64; 4];

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlayerTransform {
    pub p: PlayerVec3,
    pub q: PlayerQuat,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlayerEquipmentPose {
    pub state: PlayerEquipmentState,
    pub transform: PlayerTransform,
    pub velocity: PlayerVec3,
    pub teleport: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlayerPointGesture {
    pub kind: PointKind,
    pub hand: Hand,
    pub direction: PlayerVec3,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target: Option<PlayerVec3>,
    pub id: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlayerAnimation {
    pub grounded: bool,
    pub crouch: f64,
    pub lean: f64,
    pub bank: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "1 | -1")]
    pub lead: Option<i8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub flying: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlayerPose {
    #[ts(type = "2")]
    pub version: u8,
    pub seq: u32,
    pub sample_at: f64,
    pub teleport: u32,
    pub mode: PlayerMode,
    pub vr: bool,
    pub avatar: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gear: Option<PlayerGear>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stance: Option<PlayerSnowboardStance>,
    pub body: PlayerTransform,
    pub velocity: PlayerVec3,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub animation: Option<PlayerAnimation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub head: Option<PlayerTransform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hands: Option<[Option<PlayerTransform>; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gesture: Option<PlayerPointGesture>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gestures: Option<Vec<PlayerPointGesture>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub equipment: Option<PlayerEquipmentPose>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RideEventTarget {
    Authored,
    Reference { level: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct RideContact {
    pub point: PlayerVec3,
    pub normal: PlayerVec3,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RideEventMessage {
    pub target: RideEventTarget,
    pub mode: RaceMode,
    pub kind: RideEventKind,
    pub key: String,
    pub id: u32,
    pub rider_speed: f64,
    pub sent_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub contact: Option<RideContact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlayMember {
    pub id: String,
    pub username: String,
    pub role: MemberRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chat_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub anonymous: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub snowboard_texture_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ski_texture_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub equipment_edge_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TicketClaims {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub site_presence: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub site_course: Option<SiteCourse>,
    pub protocol: u8,
    pub nonce: String,
    pub expires_at: f64,
    pub session_id: String,
    pub client_id: String,
    pub device_label: String,
    pub member: PlayMember,
    pub color: String,
    pub course_id: String,
    pub room_id: String,
    pub public_play: bool,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlayConfig {
    pub enabled: bool,
    pub socket_path: String,
    pub ticket_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TicketRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub site_presence: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chat_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub map_source: Option<MapSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub play_room_id: Option<String>,
    pub course_id: String,
    pub room_id: String,
    pub client_id: String,
    pub device_label: String,
    pub public_play: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub editor_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub previous_ticket: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TicketResponse {
    pub ticket: String,
    pub expires_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlayPeer {
    pub session_id: String,
    pub client_id: String,
    pub device_label: String,
    pub member: PlayMember,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerPose {
    pub session_id: String,
    pub player: PlayerPose,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlayChatLine {
    pub id: u32,
    pub at: f64,
    pub session_id: String,
    pub member: PlayMember,
    pub text: String,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(rename_all = "lowercase")]
pub enum MapSource {
    Iso,
    Server,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SiteCourse {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<MapSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub room_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub play_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SiteMember {
    pub member: PlayMember,
    pub maps: Vec<SiteCourse>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum PlayClientMessage {
    SiteRoster { enabled: bool },
    Hello { protocol: u8, ticket: String },
    Renew { ticket: String },
    Pose { player: Option<Box<PlayerPose>> },
    RideEvent { event: RideEventMessage },
    Chat { text: String },
    Ping { at: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum PlayServerMessage {
    SiteActivity {
        online: u32,
        courses: std::collections::BTreeMap<String, u32>,
    },
    SitePresence {
        online: u32,
        courses: std::collections::BTreeMap<String, u32>,
        members: Vec<SiteMember>,
    },
    Welcome {
        protocol: u8,
        session_id: String,
        member: PlayMember,
        color: String,
        server_time: f64,
        course_id: String,
        room_id: String,
        publish_ms: u32,
    },
    Presence {
        course_id: String,
        peers: Vec<PlayPeer>,
    },
    Poses {
        course_id: String,
        peers: Vec<PeerPose>,
    },
    RideEvent {
        course_id: String,
        from_session_id: String,
        server_at: f64,
        event: RideEventMessage,
    },
    Chat {
        line: PlayChatLine,
    },
    ChatHistory {
        lines: Vec<PlayChatLine>,
    },
    Pong {
        echo: f64,
        server_time: f64,
    },
    Error {
        message: String,
    },
    Closed {
        code: u16,
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum PlayControlMessage {
    RevokeUser { user_id: String },
    RevokeSession { account_session_id: String },
    RemoveCourse { course_id: String },
}

import type { ManualAvailability } from '../../core/session/member-status';
import type { Role } from './policy';

/** A member as everything outside the account implementation sees one. */
export interface PublicUser {
  id: string;
  username: string;
  bio: string;
  role: Role;
  createdAt: string;
  lastSeenAt: string;
  availability: ManualAvailability;
  disabled: boolean;
  /** Authenticated byte route. Omitted until the member chooses a picture. */
  profilePictureUrl?: string;
  /** Authenticated equipment-art routes, versioned to defeat image caches after an edit. */
  snowboardTextureUrl?: string;
  skiTextureUrl?: string;
  /** CSS hex colour used on the untextured sidewalls and end caps of both gear types. */
  equipmentEdgeColor?: string;
}

/**
 * Singleton layanan untuk UI — LAZY (dipanggil pertama kali saat dibutuhkan,
 * bukan saat modul dievaluasi) supaya App bisa menangkap MissingClientEnvError
 * lebih dulu dan menampilkan layar konfigurasi, bukan crash import.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAppSupabase } from '../../lib/supabase';
import { FriendshipService } from '../../friends/friendship-service';
import { MessageService } from '../../chat/message-service';
import { ProfileService } from '../../profile/profile-service';
import { asFriendsClient } from '../../friends/types';
import { asChatClient } from '../../chat/types';
import { asProfileClient } from '../../profile/types';

let cachedClient: SupabaseClient | null = null;
let cachedFriends: FriendshipService | null = null;
let cachedMessages: MessageService | null = null;
let cachedProfiles: ProfileService | null = null;

/** Klien Supabase aplikasi (browser, PKCE, persist sesi). */
export function sb(): SupabaseClient {
  cachedClient ??= getAppSupabase();
  return cachedClient;
}

export function friendsSvc(): FriendshipService {
  cachedFriends ??= new FriendshipService({ supabase: asFriendsClient(sb()) });
  return cachedFriends;
}

export function messagesSvc(): MessageService {
  cachedMessages ??= new MessageService({ supabase: asChatClient(sb()) });
  return cachedMessages;
}

export function profilesSvc(): ProfileService {
  cachedProfiles ??= new ProfileService({ supabase: asProfileClient(sb()) });
  return cachedProfiles;
}

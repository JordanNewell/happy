/**
 * Turn-end / session-end push notifications.
 *
 * Port of the self-host expopush patch onto the monorepo push stack:
 * push when a session transitions busy -> idle (agent finished a turn, waiting
 * on the user) and when a session exits. Uses the shared Expo sender
 * (pushSend) so tokens, batching and timeout handling stay in one place.
 */

import { db } from "@/storage/db";
import { sendPushNotifications } from "@/app/push/pushSend";
import { log } from "@/utils/log";

// Per-session in-memory state for push dedup/throttle
const lastThinkingBySession = new Map<string, boolean>();
const lastPushAtBySession = new Map<string, number>();
const PUSH_COOLDOWN_MS = 10_000;
const MAP_PRUNE_THRESHOLD = 2000;

function pruneMaps() {
    if (lastThinkingBySession.size <= MAP_PRUNE_THRESHOLD) return;
    lastThinkingBySession.clear();
    lastPushAtBySession.clear();
}

// Push when a session transitions busy -> idle (turn finished / waiting on user)
export function notifyThinkingChange(userId: string, sessionId: string, thinking: boolean) {
    try {
        const prev = lastThinkingBySession.get(sessionId);
        lastThinkingBySession.set(sessionId, thinking);
        pruneMaps();
        if (prev !== true || thinking !== false) return;
        const now = Date.now();
        if (now - (lastPushAtBySession.get(sessionId) ?? 0) < PUSH_COOLDOWN_MS) return;
        lastPushAtBySession.set(sessionId, now);
        sendTurnPush(userId, 'Happy', 'Agent finished a turn');
    } catch (error) {
        log({ module: 'push', level: 'error' }, 'notifyThinkingChange error: ' + String(error));
    }
}

export function notifySessionEnd(userId: string, sessionId: string) {
    try {
        lastThinkingBySession.delete(sessionId);
        sendTurnPush(userId, 'Happy', 'Session exited');
    } catch (error) {
        log({ module: 'push', level: 'error' }, 'notifySessionEnd error: ' + String(error));
    }
}

async function sendTurnPush(userId: string, title: string, body: string) {
    try {
        const tokens = await db.accountPushToken.findMany({ where: { accountId: userId } });
        if (tokens.length === 0) {
            log({ module: 'push' }, 'No registered push tokens for user, skipping turn-end push');
            return;
        }
        const tickets = await sendPushNotifications(tokens.map(t => ({
            to: t.token,
            title,
            body,
            sound: 'default' as const
        })));
        const errors = tickets.filter(t => t.status === 'error').length;
        if (errors > 0) {
            log({ module: 'push', level: 'error' }, `Turn-end push: ${errors}/${tickets.length} ticket errors`);
        }
    } catch (error) {
        log({ module: 'push', level: 'error' }, 'Turn-end push failed: ' + String(error));
    }
}

/**
 * Relay-owned turn-end notifications and badge lifecycle.
 *
 * The CLI never signals turn end on the daemon/scanner path (onThinkingChange
 * is stubbed there), and content is end-to-end encrypted, so the relay detects
 * turns by QUIESCENCE: message POSTs for a session mark it active, and when no
 * new messages arrive for TURN_END_SILENCE_MS the turn is presumed finished.
 *
 * Badges are fully relay-owned: turn-end pushes set badge=1, and a silent
 * badge=0 push is sent when an iOS client fetches messages (the only reliable
 * "user is looking" signal — the Happy app never clears badges itself).
 *
 * Also keeps the legacy thinking-transition and session-exit hooks: they are
 * dead on the daemon path but still fire for direct-launch CLI sessions.
 */

import { db } from "@/storage/db";
import { sendPushNotifications } from "@/app/push/pushSend";
import { isUserActive } from "@/app/push/focusTracker";
import { log } from "@/utils/log";

const TURN_END_SILENCE_MS = parseInt(process.env.TURN_END_SILENCE_MS ?? "75000", 10);

// Per-session in-memory state
const quiescenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastThinkingBySession = new Map<string, boolean>();
const lastPushAtBySession = new Map<string, number>();
const PUSH_COOLDOWN_MS = 10_000;
const MAP_PRUNE_THRESHOLD = 2000;

// Whether a turn-end badge is currently set per user (badge lifecycle is relay-owned)
const badgeActiveByUser = new Map<string, boolean>();

function pruneMaps() {
    if (lastThinkingBySession.size <= MAP_PRUNE_THRESHOLD) return;
    lastThinkingBySession.clear();
    lastPushAtBySession.clear();
}

/**
 * Called on every message batch a session POSTs. Resets the quiescence timer;
 * when the session goes silent for TURN_END_SILENCE_MS, fires the turn-end push.
 */
export function noteMessageActivity(userId: string, sessionId: string) {
    const existing = quiescenceTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        quiescenceTimers.delete(sessionId);
        void fireTurnEndPush(userId, sessionId);
    }, TURN_END_SILENCE_MS);
    timer.unref?.();
    quiescenceTimers.set(sessionId, timer);
}

/**
 * Called when an iOS client fetches messages — the user is looking at the app,
 * so clear any badge we set. No-op when no badge is outstanding.
 */
export async function clearBadgeForUser(userId: string) {
    if (!badgeActiveByUser.get(userId)) return;
    badgeActiveByUser.set(userId, false);
    try {
        const tokens = await db.accountPushToken.findMany({ where: { accountId: userId } });
        if (tokens.length === 0) return;
        await sendPushNotifications(tokens.map(t => ({
            to: t.token,
            title: "",
            body: "",
            badge: 0
        })));
        log({ module: "push" }, "Cleared badge (iOS client fetched messages)");
    } catch (error) {
        log({ module: "push", level: "error" }, "Badge clear failed: " + String(error));
    }
}

async function fireTurnEndPush(userId: string, sessionId: string) {
    try {
        if (await isUserActive(userId)) {
            log({ module: "push" }, "Turn finished but a UI client is active — suppressing push");
            return;
        }
        const tokens = await db.accountPushToken.findMany({ where: { accountId: userId } });
        if (tokens.length === 0) {
            log({ module: "push" }, "No registered push tokens for user, skipping turn-end push");
            return;
        }
        badgeActiveByUser.set(userId, true);
        const tickets = await sendPushNotifications(tokens.map(t => ({
            to: t.token,
            title: "Happy",
            body: "Agent finished a turn",
            sound: "default" as const,
            badge: 1
        })));
        const errors = tickets.filter(t => t.status === "error").length;
        if (errors > 0) {
            log({ module: "push", level: "error" }, `Turn-end push: ${errors}/${tickets.length} ticket errors`);
        }
    } catch (error) {
        log({ module: "push", level: "error" }, "Turn-end push failed: " + String(error));
    }
}

function cancelQuiescence(sessionId: string) {
    const timer = quiescenceTimers.get(sessionId);
    if (timer) {
        clearTimeout(timer);
        quiescenceTimers.delete(sessionId);
    }
}

// Push when a session transitions busy -> idle (only fires on direct-launch sessions)
export function notifyThinkingChange(userId: string, sessionId: string, thinking: boolean) {
    try {
        const prev = lastThinkingBySession.get(sessionId);
        lastThinkingBySession.set(sessionId, thinking);
        pruneMaps();
        if (prev !== true || thinking !== false) return;
        const now = Date.now();
        if (now - (lastPushAtBySession.get(sessionId) ?? 0) < PUSH_COOLDOWN_MS) return;
        lastPushAtBySession.set(sessionId, now);
        void fireTurnEndPush(userId, sessionId);
    } catch (error) {
        log({ module: "push", level: "error" }, "notifyThinkingChange error: " + String(error));
    }
}

export function notifySessionEnd(userId: string, sessionId: string) {
    try {
        cancelQuiescence(sessionId);
        lastThinkingBySession.delete(sessionId);
        void (async () => {
            try {
                if (await isUserActive(userId)) return;
                const tokens = await db.accountPushToken.findMany({ where: { accountId: userId } });
                if (tokens.length === 0) return;
                await sendPushNotifications(tokens.map(t => ({
                    to: t.token,
                    title: "Happy",
                    body: "Session exited",
                    sound: "default" as const
                })));
            } catch (error) {
                log({ module: "push", level: "error" }, "Session-end push failed: " + String(error));
            }
        })();
    } catch (error) {
        log({ module: "push", level: "error" }, "notifySessionEnd error: " + String(error));
    }
}

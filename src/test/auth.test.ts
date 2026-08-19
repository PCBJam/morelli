import { describe, expect, it } from 'vitest';
import { SESSION_TTL_S, createSessionValue, verifySessionValue } from '../worker/auth';

const SECRET = 'test-secret';
const NOW = 1_700_000_000_000;

describe('session cookie', () => {
    it('round-trips a valid session', async () => {
        const value = await createSessionValue(SECRET, 'user@example.com', NOW);
        expect(await verifySessionValue(SECRET, value, NOW)).toBe('user@example.com');
        expect(await verifySessionValue(SECRET, value, NOW + (SESSION_TTL_S - 60) * 1000)).toBe('user@example.com');
    });

    it('rejects an expired session', async () => {
        const value = await createSessionValue(SECRET, 'user@example.com', NOW);
        expect(await verifySessionValue(SECRET, value, NOW + (SESSION_TTL_S + 60) * 1000)).toBeNull();
    });

    it('rejects a forged signature and a different secret', async () => {
        const value = await createSessionValue(SECRET, 'user@example.com', NOW);
        const [payload] = value.split('.');
        expect(await verifySessionValue(SECRET, `${payload}.AAAA`, NOW)).toBeNull();
        expect(await verifySessionValue('other-secret', value, NOW)).toBeNull();
    });

    it('rejects a tampered payload (signature no longer matches)', async () => {
        const value = await createSessionValue(SECRET, 'user@example.com', NOW);
        const sig = value.split('.')[1]!;
        const forged = btoa(JSON.stringify({ email: 'attacker@example.com', exp: 9999999999 }))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        expect(await verifySessionValue(SECRET, `${forged}.${sig}`, NOW)).toBeNull();
    });

    it('rejects garbage', async () => {
        expect(await verifySessionValue(SECRET, undefined, NOW)).toBeNull();
        expect(await verifySessionValue(SECRET, '', NOW)).toBeNull();
        expect(await verifySessionValue(SECRET, 'no-dot', NOW)).toBeNull();
        expect(await verifySessionValue(SECRET, '!!.!!', NOW)).toBeNull();
    });
});

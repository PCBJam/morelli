import { describe, expect, it } from 'vitest';
import { baselinesHistoryKey, casKey, isAllowedProxyKey, runImageKey, runMetaKey } from '../shared/keys';

const SHA = 'ab'.repeat(32);

describe('isAllowedProxyKey', () => {
    it('allows CAS pngs and run image pngs', () => {
        expect(isAllowedProxyKey(casKey(SHA))).toBe(true);
        expect(isAllowedProxyKey(runImageKey('pcbjam', '12345', 'chromium', '01-loading.png'))).toBe(true);
        expect(isAllowedProxyKey(runImageKey('closed-stack', '999', 'firefox-dom', 'web-login.png'))).toBe(true);
    });

    it('rejects everything else', () => {
        expect(isAllowedProxyKey('')).toBe(false);
        expect(isAllowedProxyKey('baselines/pcbjam/manifest.json')).toBe(false);
        expect(isAllowedProxyKey(runMetaKey('pcbjam', '12345'))).toBe(false);
        expect(isAllowedProxyKey(baselinesHistoryKey('baselines/', 'pcbjam', '2026-08-19T00:00:00.000Z', '1'))).toBe(false);
        expect(isAllowedProxyKey(`sha256/${SHA}.png.json`)).toBe(false);
        expect(isAllowedProxyKey(`sha256/${'A'.repeat(64)}.png`)).toBe(false); // uppercase hex
        expect(isAllowedProxyKey('runs/pcbjam/12345/chromium/../../secrets.png')).toBe(false);
        expect(isAllowedProxyKey('runs/other/12345/chromium/a.png')).toBe(false); // unknown pipeline
        expect(isAllowedProxyKey('runs/pcbjam/12x45/chromium/a.png')).toBe(false); // non-numeric run id
        expect(isAllowedProxyKey('runs/pcbjam/12345/chromium/meta.json')).toBe(false);
    });

    it('history keys stay in the URL-safe charset (no colons/dots from the ISO stamp)', () => {
        const key = baselinesHistoryKey('baselines/', 'pcbjam', '2026-08-19T12:34:56.789Z', '42');
        expect(key).toBe('baselines/pcbjam/history/2026-08-19T12-34-56-789Z-42.json');
    });
});

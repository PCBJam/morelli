import { describe, expect, it } from 'vitest';
import { parseListXml } from '../worker/s3';

describe('parseListXml', () => {
    it('extracts objects, common prefixes and the continuation token', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>pcbjam-ci-screenshots</Name>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>abc+123=</NextContinuationToken>
  <Contents><Key>runs/pcbjam/1/meta.json</Key><Size>42</Size></Contents>
  <Contents>
    <Key>runs/pcbjam/1/chromium/a.png</Key>
    <LastModified>2026-08-19T00:00:00.000Z</LastModified>
    <Size>1000</Size>
  </Contents>
  <CommonPrefixes><Prefix>runs/pcbjam/1/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>runs/pcbjam/2/</Prefix></CommonPrefixes>
</ListBucketResult>`;
        const result = parseListXml(xml);
        expect(result.objects).toEqual([
            { key: 'runs/pcbjam/1/meta.json', size: 42 },
            { key: 'runs/pcbjam/1/chromium/a.png', size: 1000 },
        ]);
        expect(result.prefixes).toEqual(['runs/pcbjam/1/', 'runs/pcbjam/2/']);
        expect(result.cursor).toBe('abc+123=');
    });

    it('handles an empty listing and xml-escaped keys', () => {
        expect(parseListXml('<ListBucketResult></ListBucketResult>')).toEqual({ objects: [], prefixes: [], cursor: null });
        const result = parseListXml('<Contents><Key>a&amp;b.png</Key><Size>1</Size></Contents>');
        expect(result.objects[0]?.key).toBe('a&b.png');
    });
});

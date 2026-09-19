import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../scripts/v32-to-v4/lib/canonical-json.mjs';
import {
  canonicalSha256,
  formatChecksumLines,
  sha256Hex,
} from '../../scripts/v32-to-v4/lib/hash.mjs';
import { redact, redactText } from '../../scripts/v32-to-v4/lib/redact.mjs';

function trapCountingProxy(target) {
  let trapCalls = 0;
  const handler = Object.create(null);
  for (const trap of [
    'defineProperty',
    'deleteProperty',
    'get',
    'getOwnPropertyDescriptor',
    'getPrototypeOf',
    'has',
    'isExtensible',
    'ownKeys',
    'preventExtensions',
    'set',
    'setPrototypeOf',
  ]) {
    Object.defineProperty(handler, trap, {
      value: () => {
        trapCalls += 1;
        throw new Error(`proxy ${trap} trap executed`);
      },
    });
  }
  return { proxy: new Proxy(target, handler), trapCalls: () => trapCalls };
}

describe('canonical JSON', () => {
  it('sorts object keys recursively without mutating the input', () => {
    const input = {
      z: 1,
      a: { z: 2, a: 3 },
      rows: [{ z: 4, a: 5 }],
    };
    const before = structuredClone(input);

    expect(canonicalJson(input)).toBe(
      '{"a":{"a":3,"z":2},"rows":[{"a":5,"z":4}],"z":1}\n',
    );
    expect(input).toEqual(before);
  });

  it('emits UTF-8 text with LF and exactly one final newline', () => {
    const output = canonicalJson({ message: 'café\r\nline' });

    expect(Buffer.from(output, 'utf8').toString('utf8')).toBe(output);
    expect(output).toBe('{"message":"café\\r\\nline"}\n');
    expect(output.endsWith('\n')).toBe(true);
    expect(output.endsWith('\n\n')).toBe(false);
    expect(output).not.toContain('\r');
  });

  it('preserves decimal-string identifiers exactly', () => {
    expect(canonicalJson({ id: '90071992547409931234567890' })).toBe(
      '{"id":"90071992547409931234567890"}\n',
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 9007199254740992])(
    'rejects unsafe or non-finite number %s',
    (value) => {
      expect(() => canonicalJson({ value })).toThrow(/number/i);
    },
  );

  it.each([
    ['undefined', undefined],
    ['BigInt', 1n],
    ['Date', new Date('2026-01-01T00:00:00.000Z')],
    ['binary data', Buffer.from('bytes')],
    ['function', () => {}],
    ['symbol', Symbol('value')],
  ])('rejects unsupported %s values', (_label, value) => {
    expect(() => canonicalJson({ value })).toThrow(/unsupported/i);
  });

  it('rejects sparse arrays and cycles', () => {
    const sparse = [];
    sparse[1] = 'value';
    const cyclic = {};
    cyclic.self = cyclic;

    expect(() => canonicalJson(sparse)).toThrow(/unsupported/i);
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/i);
  });

  it('rejects exotic arrays without invoking array hooks', () => {
    class ArraySubclass extends Array {}
    const hidden = ['value'];
    Object.defineProperty(hidden, 'hidden', { value: 'secret' });
    const accessor = ['value'];
    Object.defineProperty(accessor, '0', { get: () => 'secret' });
    const extended = ['value'];
    extended.extra = 'secret';

    for (const value of [new ArraySubclass('value'), hidden, accessor, extended]) {
      expect(() => canonicalJson(value)).toThrow(/unsupported/i);
    }

    const previousArrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    const previousObjectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    const previousArrayMap = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
    const previousSpecies = Object.getOwnPropertyDescriptor(Array, Symbol.species);
    let output;
    try {
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          throw new Error('array hook executed');
        },
      });
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          throw new Error('object hook executed');
        },
      });
      Object.defineProperty(Array.prototype, 'map', {
        configurable: true,
        value: () => {
          throw new Error('array prototype hook executed');
        },
      });
      Object.defineProperty(Array, Symbol.species, {
        configurable: true,
        get: () => {
          throw new Error('array species hook executed');
        },
      });

      output = canonicalJson({ rows: ['safe'] });
    } finally {
      if (previousArrayToJSON) {
        Object.defineProperty(Array.prototype, 'toJSON', previousArrayToJSON);
      } else {
        delete Array.prototype.toJSON;
      }
      if (previousObjectToJSON) {
        Object.defineProperty(Object.prototype, 'toJSON', previousObjectToJSON);
      } else {
        delete Object.prototype.toJSON;
      }
      Object.defineProperty(Array.prototype, 'map', previousArrayMap);
      Object.defineProperty(Array, Symbol.species, previousSpecies);
    }
    expect(output).toBe('{"rows":["safe"]}\n');
  });

  it.each([
    ['object', {}],
    ['array', []],
  ])('rejects proxy %s inputs before invoking any traps', (_label, target) => {
    const observed = trapCountingProxy(target);

    expect(() => canonicalJson(observed.proxy)).toThrow(/proxy/i);
    expect(observed.trapCalls()).toBe(0);
  });

  it('fails with a controlled error beyond the maximum depth', () => {
    let input = 'leaf';
    for (let index = 0; index < 101; index += 1) {
      input = { nested: input };
    }

    expect(() => canonicalJson(input)).toThrow(/maximum canonical JSON depth/i);
    expect(() => canonicalJson(input)).not.toThrow(RangeError);
  });

  it('serializes broad reverse-ordered objects with deterministic code-point ordering', () => {
    const input = Object.create(null);
    for (let index = 29_999; index >= 0; index -= 1) {
      input[`key-${String(index).padStart(5, '0')}`] = index;
    }

    const output = canonicalJson(input);
    expect(output.startsWith('{"key-00000":0,"key-00001":1')).toBe(true);
    expect(output.endsWith('"key-29999":29999}\n')).toBe(true);
  }, 1_000);
});

describe('hashing', () => {
  it('computes stable SHA-256 for UTF-8 input', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes equivalent canonical objects identically', () => {
    expect(canonicalSha256({ z: 1, nested: { b: 2, a: 3 } })).toBe(
      canonicalSha256({ nested: { a: 3, b: 2 }, z: 1 }),
    );
  });

  it('formats sorted unambiguous checksum lines with one final newline', () => {
    const aHash = sha256Hex('a');
    const zHash = sha256Hex('z');

    expect(
      formatChecksumLines([
        { name: 'nested/z.json', sha256: zHash },
        { name: 'a.json', sha256: aHash },
      ]),
    ).toBe(`${aHash}  a.json\n${zHash}  nested/z.json\n`);
  });

  it.each([
    '../escape.json',
    'nested/../escape.json',
    '/absolute.json',
    'C:/absolute.json',
    'C:drive-relative.json',
    '//server/share.json',
    '\\\\server\\share.json',
    'back\\slash.json',
    'line\nbreak.json',
    'line\rbreak.json',
    'line\u2028separator.json',
    'paragraph\u2029separator.json',
    'zero\u200bwidth.json',
    'nested/file:stream.json',
    'nested/trailing-dot./file.json',
    'nested/trailing-space /file.json',
    'CON',
    'con.json',
    'nested/PrN.txt',
    'nested/AUX.data.json',
    'nul.log',
    'COM1.json',
    'com9.anything',
    'LPT1',
    'nested/lpt9.txt',
  ])('rejects ambiguous or unsafe checksum name %j', (name) => {
    expect(() =>
      formatChecksumLines([{ name, sha256: sha256Hex('content') }]),
    ).toThrow(/name/i);
  });

  it('accepts the conservative ASCII paths used by planned bundle members', () => {
    const sha256 = sha256Hex('content');
    const names = [
      'envelope.json',
      'manifest.json.enc',
      'source-report.json',
      'policy_template.json',
      'data/mind_entities.ndjson.enc',
      'external/reembed-jobs.ndjson',
      'checksums.sha256',
    ];

    expect(formatChecksumLines(names.map((name) => ({ name, sha256 })))).toBe(
      names
        .toSorted()
        .map((name) => `${sha256}  ${name}\n`)
        .join(''),
    );
  });

  it.each([
    ['superscript device aliases', ['COM¹.json', 'LPT².txt']],
    ['Greek sigma forms', ['data/Σ.json', 'data/ς.json']],
    ['Latin long-s confusable', ['data/s.json', 'data/ſ.json']],
    ['NFC equivalents', ['café.json', 'cafe\u0301.json']],
  ])('rejects non-ASCII checksum-name ambiguity: %s', (_label, names) => {
    const sha256 = sha256Hex('content');
    expect(() => formatChecksumLines(names.map((name) => ({ name, sha256 })))).toThrow(/name/i);
  });

  it('rejects Windows-case collisions between otherwise safe ASCII paths', () => {
    const sha256 = sha256Hex('content');
    expect(() =>
      formatChecksumLines([
        { name: 'Report.json', sha256 },
        { name: 'report.json', sha256 },
      ]),
    ).toThrow(/collision/i);
  });

  it('rejects duplicate checksum names and malformed digests', () => {
    const sha256 = sha256Hex('content');

    expect(() =>
      formatChecksumLines([
        { name: 'same.json', sha256 },
        { name: 'same.json', sha256 },
      ]),
    ).toThrow(/duplicate/i);
    expect(() => formatChecksumLines([{ name: 'file.json', sha256: 'ABC' }])).toThrow(
      /sha-256/i,
    );
  });

  it('rejects exotic checksum collections and entries without invoking hooks', () => {
    const sha256 = sha256Hex('content');
    class EntryArray extends Array {}
    class EntryRecord {
      constructor() {
        this.name = 'file.json';
        this.sha256 = sha256;
      }
    }
    const sparse = [];
    sparse[1] = { name: 'file.json', sha256 };
    const extended = [{ name: 'file.json', sha256 }];
    extended.extra = 'unexpected';
    const accessorArray = [{ name: 'file.json', sha256 }];
    Object.defineProperty(accessorArray, '0', {
      get: () => {
        throw new Error('array getter executed');
      },
    });
    const accessorEntry = { sha256 };
    Object.defineProperty(accessorEntry, 'name', {
      enumerable: true,
      get: () => {
        throw new Error('entry getter executed');
      },
    });
    const extraEntry = { name: 'file.json', sha256, extra: 'unexpected' };

    for (const entries of [
      new EntryArray({ name: 'file.json', sha256 }),
      sparse,
      extended,
      accessorArray,
      [new EntryRecord()],
      [accessorEntry],
      [extraEntry],
    ]) {
      expect(() => formatChecksumLines(entries)).toThrow(/checksum/i);
    }
  });

  it('rejects stateful checksum getters without invoking them', () => {
    const sha256 = sha256Hex('content');
    let reads = 0;
    const entry = { sha256 };
    Object.defineProperty(entry, 'name', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'first.json' : 'second.json';
      },
    });

    expect(() => formatChecksumLines([entry])).toThrow(/checksum/i);
    expect(reads).toBe(0);
  });

  it('snapshots validated checksum strings without invoking map or species hooks', () => {
    const sha256 = sha256Hex('content');
    const entry = Object.create(null);
    Object.defineProperties(entry, {
      name: { enumerable: true, value: 'file.json' },
      sha256: { enumerable: true, value: sha256 },
    });
    const previousMap = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
    const previousSpecies = Object.getOwnPropertyDescriptor(Array, Symbol.species);
    let output;
    try {
      Object.defineProperty(Array.prototype, 'map', {
        configurable: true,
        value: () => {
          throw new Error('map hook executed');
        },
      });
      Object.defineProperty(Array, Symbol.species, {
        configurable: true,
        get: () => {
          throw new Error('species hook executed');
        },
      });
      output = formatChecksumLines([entry]);
    } finally {
      Object.defineProperty(Array.prototype, 'map', previousMap);
      Object.defineProperty(Array, Symbol.species, previousSpecies);
    }

    expect(output).toBe(`${sha256}  file.json\n`);
  });
});

describe('redaction', () => {
  const secrets = {
    password: 'pg-PASSWORD-seed-9417',
    passphrase: 'phrase-SEED-2083',
    secret: 'client-SECRET-seed-6229',
    token: 'tok_SEED_837451',
    apiKey: 'api_SEED_485920',
    auth: 'Bearer-SEED-1642',
    user: 'db_seed_user_7318',
    environment: 'env_SEED_592643',
  };

  it('redacts nested sensitive keys without mutating objects or arrays', () => {
    const input = {
      password: secrets.password,
      nested: [{ passphrase: secrets.passphrase, clientSecret: secrets.secret }],
      authToken: secrets.token,
      api_key: secrets.apiKey,
      authorization: secrets.auth,
      safe: 'visible',
    };
    const before = structuredClone(input);

    expect(redact(input)).toEqual({
      password: '[REDACTED]',
      nested: [{ passphrase: '[REDACTED]', clientSecret: '[REDACTED]' }],
      authToken: '[REDACTED]',
      api_key: '[REDACTED]',
      authorization: '[REDACTED]',
      safe: 'visible',
    });
    expect(input).toEqual(before);
  });

  it('rejects exotic arrays without invoking getters or inherited hooks', () => {
    class ArraySubclass extends Array {}
    const hidden = ['value'];
    Object.defineProperty(hidden, 'hidden', { value: secrets.password });
    const accessor = ['value'];
    Object.defineProperty(accessor, '0', {
      get: () => {
        throw new Error('getter executed');
      },
    });
    const extended = ['value'];
    extended.extra = secrets.password;

    for (const value of [new ArraySubclass('value'), hidden, accessor, extended]) {
      expect(() => redact(value)).toThrow(/unsupported/i);
    }

    const previousArrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    const previousObjectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    const previousArrayPush = Object.getOwnPropertyDescriptor(Array.prototype, 'push');
    const previousSpecies = Object.getOwnPropertyDescriptor(Array, Symbol.species);
    let output;
    try {
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          throw new Error('array hook executed');
        },
      });
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          throw new Error('object hook executed');
        },
      });
      Object.defineProperty(Array.prototype, 'push', {
        configurable: true,
        value: () => {
          throw new Error('array prototype hook executed');
        },
      });
      Object.defineProperty(Array, Symbol.species, {
        configurable: true,
        get: () => {
          throw new Error('array species hook executed');
        },
      });

      output = redact({ rows: ['safe'] }, { environmentValues: [] });
    } finally {
      if (previousArrayToJSON) {
        Object.defineProperty(Array.prototype, 'toJSON', previousArrayToJSON);
      } else {
        delete Array.prototype.toJSON;
      }
      if (previousObjectToJSON) {
        Object.defineProperty(Object.prototype, 'toJSON', previousObjectToJSON);
      } else {
        delete Object.prototype.toJSON;
      }
      Object.defineProperty(Array.prototype, 'push', previousArrayPush);
      Object.defineProperty(Array, Symbol.species, previousSpecies);
    }
    expect(output).toEqual({ rows: ['safe'] });
  });

  it.each([
    ['structured object', {}, (proxy) => redact(proxy)],
    ['structured array', [], (proxy) => redact(proxy)],
    ['options', {}, (proxy) => redact('safe', proxy)],
    ['environment object', {}, (proxy) => redact('safe', { environmentValues: proxy })],
    ['environment array', [], (proxy) => redact('safe', { environmentValues: proxy })],
  ])('rejects proxy %s before invoking any traps', (_label, target, invoke) => {
    const observed = trapCountingProxy(target);

    expect(() => invoke(observed.proxy)).toThrow(/proxy/i);
    expect(observed.trapCalls()).toBe(0);
  });

  it('fails with a controlled error beyond the redaction maximum depth', () => {
    let input = 'leaf';
    for (let index = 0; index < 101; index += 1) {
      input = { nested: input };
    }

    expect(() => redact(input)).toThrow(/maximum redaction depth/i);
    expect(() => redact(input)).not.toThrow(RangeError);
  });

  it('redacts own __proto__ content without changing the output prototype', () => {
    const input = JSON.parse(`{"__proto__":{"password":"${secrets.password}"}}`);
    const output = redact(input);

    expect(Object.getPrototypeOf(output)).toBeNull();
    expect(Object.hasOwn(output, '__proto__')).toBe(true);
    expect(output.__proto__.password).toBe('[REDACTED]');
  });

  it('redacts URL userinfo and sensitive query parameters', () => {
    const input =
      `postgresql://${secrets.user}:${secrets.password}@db.example/mind` +
      `?sslmode=require&access_token=${secrets.token}&api_key=${secrets.apiKey}`;
    const output = redactText(input);

    expect(output).toContain('postgresql://[REDACTED]@db.example/mind');
    expect(output).toContain('sslmode=require');
    expect(output).not.toContain(secrets.user);
    expect(output).not.toContain(secrets.password);
    expect(output).not.toContain(secrets.token);
    expect(output).not.toContain(secrets.apiKey);
  });

  it('redacts complete URL userinfo when a raw password contains @', () => {
    const input =
      `connect postgres://${secrets.user}:pa@ss@db.example/mind now; ` +
      'email operator@example.com and visit https://db.example/mind';
    const output = redactText(input);

    expect(output).toBe(
      'connect postgres://[REDACTED]@db.example/mind now; ' +
        'email operator@example.com and visit https://db.example/mind',
    );
    expect(output).not.toContain(secrets.user);
    expect(output).not.toContain('pa@ss');
  });

  it('repeatedly decodes query keys, recognizes pwd, and fails closed on malformed or overencoded keys', () => {
    const input =
      `https://db.example/mind?access%5Ftoken=${secrets.token}` +
      `&%74oken=${secrets.auth}&%2574oken=${secrets.secret}` +
      `&pwd=${secrets.password}&%74oken%=${secrets.apiKey}` +
      `&%25252574oken=${secrets.passphrase}&safe=visible`;
    const output = redactText(input);

    expect(output).toBe(
      'https://db.example/mind?access%5Ftoken=[REDACTED]' +
        '&%74oken=[REDACTED]&%2574oken=[REDACTED]' +
        '&pwd=[REDACTED]&%74oken%=[REDACTED]' +
        '&%25252574oken=[REDACTED]&safe=visible',
    );
    for (const secret of [
      secrets.token,
      secrets.auth,
      secrets.secret,
      secrets.password,
      secrets.apiKey,
      secrets.passphrase,
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('redacts explicitly supplied environment values', () => {
    expect(
      redactText(`DATABASE_URL=${secrets.environment}`, {
        environmentValues: { DATABASE_URL: secrets.environment },
      }),
    ).toBe('DATABASE_URL=[REDACTED]');
  });

  it('redacts multiline PostgreSQL errors and connection strings', () => {
    const error = [
      `error: password authentication failed for user "${secrets.user}"`,
      `connection: host=db.example dbname=mind user=${secrets.user} password=${secrets.password}`,
      `DATABASE_URL=postgres://${secrets.user}:${secrets.password}@db.example/mind?token=${secrets.token}`,
      `Authorization: Bearer ${secrets.auth}`,
    ].join('\n');
    const output = redactText(error);

    for (const secret of [secrets.user, secrets.password, secrets.token, secrets.auth]) {
      expect(output).not.toContain(secret);
    }
    expect(output.split('\n')).toHaveLength(4);
  });

  it('scans prefixed labels, authorization schemes, and escaped quoted credentials', () => {
    const input = [
      `ACCESS_TOKEN=${secrets.token} trailing=visible`,
      `DATABASE_PASSWORD="db-pa\\\"ss-tail-SEED" trailing=visible`,
      `API_KEY='${secrets.apiKey}' trailing=visible`,
      `Authorization: Bearer "bearer\\\"tail-SEED" trailing=visible`,
      `Authorization=Basic 'basic\\'tail-SEED' trailing=visible`,
      `DATABASE_URL="postgres://user:dsn\\\"tail-SEED@db.example/mind" trailing=visible`,
    ].join('\n');
    const output = redactText(input);

    for (const secretPart of [
      secrets.token,
      secrets.apiKey,
      'db-pa',
      'ss-tail-SEED',
      'bearer',
      'basic',
      'dsn',
      'tail-SEED',
    ]) {
      expect(output).not.toContain(secretPart);
    }
    expect(output.match(/trailing=visible/gu)).toHaveLength(6);
    expect(output).toContain('Authorization: Bearer [REDACTED]');
    expect(output).toContain('Authorization=Basic [REDACTED]');
  });

  it('redacts quoted JSON and log credential labels without altering ordinary fields', () => {
    const input = [
      `{"ACCESS_TOKEN":"${secrets.token}","safe":"visible"}`,
      `{"DATABASE_PASSWORD": "${secrets.password}", "message": "ordinary prose"}`,
      `{"Authorization":"Bearer ${secrets.auth}","status":"ok"}`,
      `level=error ACCESS_TOKEN='${secrets.token}' action=retry`,
    ].join('\n');
    const output = redactText(input);

    for (const secret of [secrets.token, secrets.password, secrets.auth]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('"safe":"visible"');
    expect(output).toContain('"message": "ordinary prose"');
    expect(output).toContain('"status":"ok"');
    expect(output).toContain('action=retry');
  });

  it('redacts JSON-escaped URL userinfo and suffixed authorization credentials', () => {
    const input = [
      `{"endpoint":"postgres:\\/\\/${secrets.user}:${secrets.password}@db.example/mind"}`,
      `HTTP_AUTHORIZATION: Bearer ${secrets.token} trailing=visible`,
      `PROXY_AUTHORIZATION=Basic ${secrets.auth} trailing=visible`,
    ].join('\n');
    const output = redactText(input);

    for (const secret of [secrets.user, secrets.password, secrets.token, secrets.auth]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('postgres:\\/\\/[REDACTED]@db.example/mind');
    expect(output).toContain('HTTP_AUTHORIZATION: Bearer [REDACTED] trailing=visible');
    expect(output).toContain('PROXY_AUTHORIZATION=Basic [REDACTED] trailing=visible');
  });

  it('handles long non-secret prose without over-redaction', () => {
    const prose = `${'ordinary words and punctuation. '.repeat(5_000)}done`;
    expect(redactText(prose)).toBe(prose);
  });

  it('redacts NFKC and targeted confusable secret labels without hiding ordinary localized keys', () => {
    const output = redact({
      ＡＰＩ＿ＫＥＹ: secrets.apiKey,
      раѕѕωогԁ: secrets.password,
      tοκεν: secrets.token,
      ѕесгеτ: secrets.secret,
      аυτһ: secrets.auth,
      αρі_κеу: secrets.apiKey,
      рωԁ: secrets.passphrase,
      café: 'visible café',
      ключ: 'видимый',
      safe: 'visible',
    });

    expect(output).toEqual({
      ＡＰＩ＿ＫＥＹ: '[REDACTED]',
      раѕѕωогԁ: '[REDACTED]',
      tοκεν: '[REDACTED]',
      ѕесгеτ: '[REDACTED]',
      аυτһ: '[REDACTED]',
      αρі_κеу: '[REDACTED]',
      рωԁ: '[REDACTED]',
      café: 'visible café',
      ключ: 'видимый',
      safe: 'visible',
    });
    expect(
      redactText(
        `ＡＰＩ＿ＫＥＹ=${secrets.apiKey} раѕѕωогԁ=${secrets.password} ` +
          `tοκεν=${secrets.token} ѕесгеτ=${secrets.secret} аυτһ=${secrets.auth} ` +
          `αρі_κеу=${secrets.apiKey} рωԁ=${secrets.passphrase} café=visible ключ=видимый`,
      ),
    ).toBe(
      'ＡＰＩ＿ＫＥＹ=[REDACTED] раѕѕωогԁ=[REDACTED] ' +
        'tοκεν=[REDACTED] ѕесгеτ=[REDACTED] аυτһ=[REDACTED] ' +
        'αρі_κеу=[REDACTED] рωԁ=[REDACTED] café=visible ключ=видимый',
    );
  });

  it('rejects accessor-backed environment secret collections without invoking getters', () => {
    const environmentValues = {};
    Object.defineProperty(environmentValues, 'TOKEN', {
      enumerable: true,
      get: () => {
        throw new Error('environment getter executed');
      },
    });
    const options = {};
    Object.defineProperty(options, 'environmentValues', {
      get: () => {
        throw new Error('getter executed');
      },
    });

    expect(() => redactText('safe', { environmentValues })).toThrow(/environmentValues/i);
    expect(() => redactText('safe', options)).toThrow(/redaction options/i);
  });

  it('keeps a seeded secret corpus out of log/report-shaped canonical output', () => {
    const report = {
      event: 'migration.failed',
      credentials: {
        password: secrets.password,
        apiKey: secrets.apiKey,
        passphrase: secrets.passphrase,
        clientSecret: secrets.secret,
        authorization: secrets.auth,
      },
      error:
        `postgresql://${secrets.user}:${secrets.password}@localhost/mind` +
        `?access_token=${secrets.token}`,
      detail: `env=${secrets.environment}`,
    };
    const output = canonicalJson(
      redact(report, { environmentValues: [secrets.environment] }),
    );

    for (const secret of Object.values(secrets)) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[REDACTED]');
  });
});

describe('prototype pollution safety', () => {
  it('never executes an inherited index setter while building canonical, checksum, or redacted output', () => {
    const shaA = sha256Hex('a');
    const shaZ = sha256Hex('z');
    const checksumEntries = [
      { name: 'z.json', sha256: shaZ },
      { name: 'a.json', sha256: shaA },
    ];
    const redactionInput = { rows: [{ password: 'hidden', safe: 'visible' }] };
    const redactionOptions = { environmentValues: { TOKEN: 'environment-secret' } };
    const previousIndex = Object.getOwnPropertyDescriptor(Array.prototype, '0');
    let setterCalls = 0;
    let canonicalOutput;
    let checksumOutput;
    let redactedOutput;

    try {
      Object.defineProperty(Array.prototype, '0', {
        configurable: true,
        set: () => {
          setterCalls += 1;
        },
      });
      canonicalOutput = canonicalJson({ z: 1, a: 2 });
      checksumOutput = formatChecksumLines(checksumEntries);
      redactedOutput = redact(redactionInput, redactionOptions);
    } finally {
      if (previousIndex) {
        Object.defineProperty(Array.prototype, '0', previousIndex);
      } else {
        delete Array.prototype[0];
      }
    }

    expect(setterCalls).toBe(0);
    expect(canonicalOutput).toBe('{"a":2,"z":1}\n');
    expect(checksumOutput).toBe(`${shaA}  a.json\n${shaZ}  z.json\n`);
    expect(redactedOutput).toEqual({ rows: [{ password: '[REDACTED]', safe: 'visible' }] });
    expect(Array.isArray(redactedOutput.rows)).toBe(true);
  });
});

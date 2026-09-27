// Unit tests never touch the database; config still needs syntactically valid values.
process.env.DATABASE_URL ??= 'postgres://unit:unit@127.0.0.1:1/unit';
process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'fs';
// The SSRF redirect test runs a local server on this port and allows only it (development-only escape hatch).
process.env.IMAGE_FETCH_DEV_ALLOW = '127.0.0.1:47123,127.0.0.1:47125,127.0.0.1:47126';

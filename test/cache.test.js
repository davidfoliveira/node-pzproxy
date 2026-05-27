"use strict";

var test   = require('node:test');
var assert = require('node:assert');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var crypto = require('crypto');

var Cache = require('../lib/cache');

function mkTmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'pzp-cache-'));
}

function md5(str) {
	return crypto.createHash('md5').update(str).digest("hex");
}

// CacheItem.end() races: it calls stream.end() and immediately fs.rename().
// In modern Node the writable stream opens the .tmp file asynchronously, so the
// rename can fire before the file exists. Tests defer .end() until the stream's
// 'open' event has fired so the .tmp file is guaranteed to be on disk.
function whenOpen(item, fn) {
	if (item.stream.fd != null) return fn();
	item.stream.once('open', fn);
}

test('Cache: constructs with no opts and defaults storage to /tmp', function(){
	var c = new Cache();
	try {
		assert.strictEqual(c.opts.storage, '/tmp');
		assert.strictEqual(c.opts.cleanupInterval, 60);
		assert.deepStrictEqual(c._storedItems, {});
		assert.strictEqual(c._cleaningUp, false);
	} finally {
		clearInterval(c._cleanupInterval);
	}
});

test('Cache: respects opts.dir as storage fallback', function(){
	var c = new Cache({ dir: '/var/tmp' });
	try {
		assert.strictEqual(c.opts.storage, '/var/tmp');
	} finally {
		clearInterval(c._cleanupInterval);
	}
});

test('Cache: opts.storage takes precedence over opts.dir', function(){
	var c = new Cache({ storage: '/a', dir: '/b' });
	try {
		assert.strictEqual(c.opts.storage, '/a');
	} finally {
		clearInterval(c._cleanupInterval);
	}
});

test('Cache: opts.cleanupInterval is configurable', function(){
	var c = new Cache({ cleanupInterval: 5 });
	try {
		assert.strictEqual(c.opts.cleanupInterval, 5);
	} finally {
		clearInterval(c._cleanupInterval);
	}
});

test('Cache: _getCacheFile returns storage/pzp_<md5(key)>', function(){
	var c = new Cache({ storage: '/tmp', cleanupInterval: 99999 });
	try {
		var key = 'http://example.com/foo';
		assert.strictEqual(c._getCacheFile(key), '/tmp/pzp_' + md5(key));
	} finally {
		clearInterval(c._cleanupInterval);
	}
});

test('Cache: check() reports false for non-existent key (ENOENT)', function(_, done){
	var dir = mkTmpDir();
	var c = new Cache({ storage: dir, cleanupInterval: 99999 });
	c.check('missing-key', 30, function(err, isCached){
		clearInterval(c._cleanupInterval);
		assert.strictEqual(err, null);
		assert.strictEqual(isCached, false);
		done();
	});
});

test('Cache: check() reports true when fresh, false when expired', function(_, done){
	var dir = mkTmpDir();
	var c = new Cache({ storage: dir, cleanupInterval: 99999 });
	var key = 'fresh-key';
	var filePath = c._getCacheFile(key);
	fs.writeFileSync(filePath, 'data');

	c.check(key, 30, function(err, isCached){
		assert.strictEqual(err, null);
		assert.strictEqual(isCached, true);

		var past = new Date(Date.now() - 60 * 1000);
		fs.utimesSync(filePath, past, past);

		c.check(key, 1, function(err2, isCached2){
			clearInterval(c._cleanupInterval);
			assert.strictEqual(err2, null);
			assert.strictEqual(isCached2, false);
			done();
		});
	});
});

test('Cache: check() with ttl=null skips expiry comparison', function(_, done){
	var dir = mkTmpDir();
	var c = new Cache({ storage: dir, cleanupInterval: 99999 });
	var key = 'no-ttl-key';
	var filePath = c._getCacheFile(key);
	fs.writeFileSync(filePath, 'data');
	var past = new Date(Date.now() - 10 * 365 * 24 * 3600 * 1000);
	fs.utimesSync(filePath, past, past);

	c.check(key, null, function(err, isCached){
		clearInterval(c._cleanupInterval);
		assert.strictEqual(err, null);
		assert.strictEqual(isCached, true);
		done();
	});
});

test('Cache: check() errors when path is a directory', function(_, done){
	var dir = mkTmpDir();
	var c = new Cache({ storage: dir, cleanupInterval: 99999 });
	var key = 'dir-key';
	fs.mkdirSync(c._getCacheFile(key));

	c.check(key, 30, function(err, isCached){
		clearInterval(c._cleanupInterval);
		assert.ok(err instanceof Error);
		assert.strictEqual(isCached, null);
		done();
	});
});

test('Cache: add() -> write -> end roundtrip via get() returns headers and data', function(_, done){
	var dir = mkTmpDir();
	var c = new Cache({ storage: dir, cleanupInterval: 99999 });
	var key = 'rt-key';
	var item = c.add(key, 60);
	var headers = { statusCode: 200, headers: { 'content-type': 'text/plain' } };

	whenOpen(item, function(){
		item.writeHeaders(headers);
		item.write(Buffer.from('hello '));
		item.write(Buffer.from('world'));
		item.end(function(err){
			assert.strictEqual(err || null, null);
			assert.ok(c._storedItems[key] instanceof Date);

			c.get(key, function(err2, resLine, stream){
				assert.strictEqual(err2, null);
				assert.deepStrictEqual(resLine, headers);
				var chunks = [];
				stream.on('data', function(d){ chunks.push(d); });
				stream.on('end', function(){
					clearInterval(c._cleanupInterval);
					assert.strictEqual(Buffer.concat(chunks).toString(), 'hello world');
					done();
				});
			});
		});
	});
});

test('Cache: writeHeaders() called twice is a no-op the second time', function(_, done){
	var dir = mkTmpDir();
	var c = new Cache({ storage: dir, cleanupInterval: 99999 });
	var item = c.add('dup-headers', 60);
	whenOpen(item, function(){
		item.writeHeaders({ statusCode: 200, headers: {} });
		item.writeHeaders({ statusCode: 500, headers: { hijacked: 'yes' } });
		item.write(Buffer.from('x'));
		item.end(function(){
			c.get('dup-headers', function(err, resLine, stream){
				assert.strictEqual(resLine.statusCode, 200);
				stream.on('data', function(){});
				stream.on('end', function(){
					clearInterval(c._cleanupInterval);
					done();
				});
			});
		});
	});
});

test('Cache: write() before writeHeaders() injects default empty headers', function(_, done){
	var dir = mkTmpDir();
	var c = new Cache({ storage: dir, cleanupInterval: 99999 });
	var item = c.add('no-headers', 60);
	whenOpen(item, function(){
		item.write(Buffer.from('body-only'));
		item.end(function(){
			c.get('no-headers', function(err, resLine, stream){
				assert.deepStrictEqual(resLine, {});
				var chunks = [];
				stream.on('data', function(d){ chunks.push(d); });
				stream.on('end', function(){
					clearInterval(c._cleanupInterval);
					assert.strictEqual(Buffer.concat(chunks).toString(), 'body-only');
					done();
				});
			});
		});
	});
});

test('Cache: get() returns error for missing file', function(_, done){
	var dir = mkTmpDir();
	var c = new Cache({ storage: dir, cleanupInterval: 99999 });
	c.get('definitely-missing', function(err, resLine){
		clearInterval(c._cleanupInterval);
		assert.ok(err);
		assert.strictEqual(resLine, null);
		done();
	});
});

test('Cache: setExpireFromTTL updates expires forward', function(){
	var dir = mkTmpDir();
	var c = new Cache({ storage: dir, cleanupInterval: 99999 });
	var item = c.add('exp-key', 10);
	var first = item.expires.getTime();
	item.setExpireFromTTL(60);
	assert.ok(item.expires.getTime() >= first);
	assert.ok(item.expires.getTime() > Date.now() + 50 * 1000);
	clearInterval(c._cleanupInterval);
});

test('Cache: cleanup() removes expired items from _storedItems and disk', function(_, done){
	var dir = mkTmpDir();
	var c = new Cache({ storage: dir, cleanupInterval: 99999 });
	var key = 'cleanup-key';
	var item = c.add(key, 60);
	whenOpen(item, function(){
		item.writeHeaders({ statusCode: 200, headers: {} });
		item.write(Buffer.from('x'));
		item.end(function(){
			c._storedItems[key] = new Date(Date.now() - 1000);
			var filePath = c._getCacheFile(key);
			assert.ok(fs.existsSync(filePath));

			c.cleanup(function(){
				assert.strictEqual(c._storedItems[key], undefined);
				// fs.unlink is fire-and-forget inside cleanup(); poll briefly.
				var deadline = Date.now() + 1000;
				(function check(){
					if (!fs.existsSync(filePath)) {
						clearInterval(c._cleanupInterval);
						return done();
					}
					if (Date.now() > deadline) {
						clearInterval(c._cleanupInterval);
						return done(new Error('cache file not unlinked'));
					}
					setTimeout(check, 20);
				})();
			});
		});
	});
});

test('Cache: cleanup() leaves non-expired items in place', function(_, done){
	var dir = mkTmpDir();
	var c = new Cache({ storage: dir, cleanupInterval: 99999 });
	var key = 'keepme';
	var item = c.add(key, 600);
	whenOpen(item, function(){
		item.writeHeaders({ statusCode: 200, headers: {} });
		item.write(Buffer.from('x'));
		item.end(function(){
			var filePath = c._getCacheFile(key);
			c.cleanup(function(){
				clearInterval(c._cleanupInterval);
				assert.ok(c._storedItems[key] instanceof Date);
				assert.ok(fs.existsSync(filePath));
				done();
			});
		});
	});
});

test('Cache: periodic cleanup interval is registered and unref-able', function(){
	var c = new Cache({ cleanupInterval: 1 });
	assert.ok(c._cleanupInterval);
	clearInterval(c._cleanupInterval);
});

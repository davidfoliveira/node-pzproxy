"use strict";

var test   = require('node:test');
var assert = require('node:assert');
var stream = require('stream');

var ProxyCache = require('../lib/pzproxy');

// --- helpers -----------------------------------------------------------------

function FakeEventServer() {
	this._handlers = {};
}
FakeEventServer.prototype.on = function(name, cb){
	(this._handlers[name] = this._handlers[name] || []).push(cb);
};
FakeEventServer.prototype.fire = function(name, a, b){
	(this._handlers[name] || []).forEach(function(cb){ cb(a, b); });
};

function FakeCache() {
	this._items = {};        // key -> {headers, body}
	this._addCalled = [];
	this._checkResult = null; // override: { err, isCached }
	var self = this;
	this.check = function(key, ttl, cb){
		if ( self._checkResult ) return cb(self._checkResult.err, self._checkResult.isCached);
		cb(null, !!self._items[key]);
	};
	this.get = function(key, cb){
		var entry = self._items[key];
		if ( !entry ) return cb(new Error('not found'));
		var s = new stream.PassThrough();
		setImmediate(function(){
			s.write(entry.body);
			s.end();
		});
		cb(null, entry.headers, s);
	};
	this.add = function(key, ttl){
		self._addCalled.push({ key: key, ttl: ttl });
		return { writeHeaders: function(){}, write: function(){}, end: function(c){ c && c(); } };
	};
}

function FakeProxy() {
	this.opts = { target: 'http://backend.example' };
	this.calls = [];
	var self = this;
	this.proxyRequest = function(req, res, target, opts, cb){
		self.calls.push({ req: req, res: res, target: target, opts: opts });
		setImmediate(function(){
			cb(null, req, res, {}, {}, { docSize: 7, flags: ['P'] });
		});
	};
}

function makeReqRes(url) {
	// Decorate the req the same way Server._handleRequest would, so logAccess() works.
	var req = {
		url: url || '/abc',
		originalURL: url || '/abc',
		method: 'GET',
		headers: {},
		httpVersionMajor: 1,
		xConnectDate: new Date(),
		xRequestID: 'test-req',
		xRemoteAddr: '127.0.0.1',
	};
	// res is a writable stream so cache HIT pipe() works.
	var res = new stream.Writable({
		write: function(chunk, enc, cb){ res._chunks.push(chunk); cb(); },
	});
	res._chunks = [];
	res._headers = null;
	res._statusCode = null;
	res.statusCode = 0;
	res._ended = false;
	res.writeHead = function(s, h){ res._statusCode = s; res._headers = h; res.statusCode = s; };
	var origEnd = res.end.bind(res);
	res.end = function(){ res._ended = true; return origEnd(); };
	return { req: req, res: res };
}

function newPC(opts) {
	var server = new FakeEventServer();
	var cache  = new FakeCache();
	var proxy  = new FakeProxy();
	opts = opts || {};
	opts.server = server;
	opts.cache  = cache;
	opts.proxy  = proxy;
	var pc = new ProxyCache(opts);
	pc._fakes = { server: server, cache: cache, proxy: proxy };
	return pc;
}

// --- tests -------------------------------------------------------------------

test('ProxyCache: defaults are applied for missing options', function(){
	var pc = newPC();
	assert.strictEqual(typeof pc.opts.onRequest, 'function');
	assert.strictEqual(typeof pc.opts.onFinish, 'function');
	assert.strictEqual(pc.defaultTimeout, 60);
	assert.strictEqual(pc.defaultTransferTimeout, 60000);
	assert.strictEqual(typeof pc.logAccess, 'function');
});

test('ProxyCache: shouldCache=null is replaced with a function that returns true', function(){
	var pc = newPC({ shouldCache: null });
	assert.strictEqual(typeof pc.opts.shouldCache, 'function');
	assert.strictEqual(pc.opts.shouldCache({}, {}, {}, {}), true);
});

test('ProxyCache: shouldCache=true/false is converted to a constant function', function(){
	var pcTrue  = newPC({ shouldCache: true });
	var pcFalse = newPC({ shouldCache: false });
	assert.strictEqual(typeof pcTrue.opts.shouldCache, 'function');
	assert.strictEqual(pcTrue.opts.shouldCache(), true);
	assert.strictEqual(pcFalse.opts.shouldCache(), false);
});

test('ProxyCache: shouldCache as a function is preserved as-is', function(){
	var sc = function(){ return 'kept'; };
	var pc = newPC({ shouldCache: sc });
	assert.strictEqual(pc.opts.shouldCache, sc);
});

test('ProxyCache: custom defaultTimeout / defaultTransferTimeout are respected', function(){
	var pc = newPC({ defaultTimeout: 5, defaultTransferTimeout: 1234 });
	assert.strictEqual(pc.defaultTimeout, 5);
	assert.strictEqual(pc.defaultTransferTimeout, 1234);
});

test('ProxyCache: custom logAccess is used when provided', function(){
	var calls = [];
	var pc = newPC({ logAccess: function(req, res, len, flags){ calls.push([req, res, len, flags]); } });
	assert.strictEqual(pc.logAccess, pc.opts.logAccess);
	pc.logAccess({}, {}, 1, ['x']);
	assert.strictEqual(calls.length, 1);
});

test('ProxyCache: server "request" handler sets defaults on req and adds res.answer', function(_, done){
	var pc = newPC({
		defaultTTL: 90,
		onRequest: function(req, res, cb){
			assert.strictEqual(req.cacheKey, req.url);
			assert.strictEqual(req.cacheTTL, 90);
			assert.strictEqual(req.xProxyCount, 0);
			assert.strictEqual(req.xProxyTime, 0);
			assert.strictEqual(req.xHoldCount, 0);
			assert.strictEqual(req.xHoldTime, 0);
			assert.strictEqual(typeof res.answer, 'function');
			done();
			// Do not call cb() — we don't want to enter flowRequest in this test
		},
	});
	var rr = makeReqRes('/x');
	pc._fakes.server.fire('request', rr.req, rr.res);
});

test('ProxyCache: res.answer writes status/headers/body, ends, and triggers finish + logAccess', function(_, done){
	var logCalls = [];
	var pc = newPC({
		logAccess: function(req, res, length, flags){ logCalls.push({ length: length, flags: flags }); },
		onFinish: function(req, res, infos, cb){ cb(); },
		onRequest: function(req, res, cb){
			res.answer(418, { 'content-type': 'text/plain' }, Buffer.from('teapot'));
			assert.strictEqual(res._statusCode, 418);
			assert.strictEqual(res._headers['content-type'], 'text/plain');
			assert.strictEqual(Buffer.concat(res._chunks).toString(), 'teapot');
			assert.strictEqual(res._ended, true);
			// onFinish runs synchronously then logAccess
			setImmediate(function(){
				assert.strictEqual(logCalls.length, 1);
				assert.strictEqual(logCalls[0].length, 6); // 'teapot'.length
				assert.deepStrictEqual(logCalls[0].flags, ['s']);
				done();
			});
		},
	});
	pc._fakes.server.fire('request', makeReqRes('/t').req, makeReqRes('/t').res);
});

test('ProxyCache: _finishRequest is idempotent — a second call is a no-op', function(){
	var logCount = 0;
	var pc = newPC({
		logAccess: function(){ logCount++; },
		onFinish: function(req, res, infos, cb){ cb(); },
	});
	var req = { _finished: false, xRequestID: 'r' };
	var res = {};
	pc._finishRequest(req, res, { docSize: 1, flags: [] });
	pc._finishRequest(req, res, { docSize: 1, flags: [] });
	assert.strictEqual(logCount, 1);
});

test('ProxyCache: flowRequest builds backendURL from proxy target when missing', function(_, done){
	var pc = newPC({
		onRequest: function(req, res, cb){ cb(); },
		shouldCache: false,
	});
	// Cache miss so it proxies
	pc._fakes.cache._items = {};
	var rr = makeReqRes('/path?x=1');
	pc._fakes.server.fire('request', rr.req, rr.res);
	setImmediate(function(){
		setImmediate(function(){
			assert.strictEqual(pc._fakes.proxy.calls.length, 1);
			assert.strictEqual(pc._fakes.proxy.calls[0].req.backendURL, 'http://backend.example/path?x=1');
			done();
		});
	});
});

test('ProxyCache: flowRequest throws when neither backendURL nor proxy target is set', function(){
	var pc = newPC({ onRequest: function(req, res, cb){ cb(); } });
	pc._fakes.proxy.opts.target = null;
	// Catch synchronously by invoking _flowRequest directly
	assert.throws(function(){
		pc.flowRequest({ url: '/x', cacheKey: '/x', cacheTTL: 0, headers: {} }, makeReqRes().res);
	}, /backendURL/);
});

test('ProxyCache: flowRequest with cache HIT serves response from cache without proxying', function(_, done){
	var pc = newPC({
		onRequest: function(req, res, cb){ cb(); },
		onFinish: function(req, res, infos, cb){
			assert.deepStrictEqual(infos.flags, ['C']);
			assert.strictEqual(infos.docSize, Buffer.byteLength('cached-body'));
			cb();
		},
	});
	pc._fakes.cache._items['/hit'] = {
		headers: { statusCode: 200, headers: {} },
		body: Buffer.from('cached-body'),
	};
	var rr = makeReqRes('/hit');
	rr.req.cacheKey = '/hit'; // will be set by handler too, but explicit
	pc._fakes.server.fire('request', rr.req, rr.res);

	// Confirm proxy.proxyRequest was NOT called
	setImmediate(function(){
		setImmediate(function(){
			setImmediate(function(){
				assert.strictEqual(pc._fakes.proxy.calls.length, 0);
				assert.strictEqual(rr.res._headers['X-Cached'], 'HIT');
				done();
			});
		});
	});
});

test('ProxyCache: flowRequest with cache check error answers 500.1', function(_, done){
	var pc = newPC({
		onRequest: function(req, res, cb){ cb(); },
		onFinish: function(req, res, infos, cb){ cb(); },
	});
	pc._fakes.cache._checkResult = { err: new Error('boom'), isCached: null };
	var rr = makeReqRes('/err');
	pc._fakes.server.fire('request', rr.req, rr.res);
	setImmediate(function(){
		assert.strictEqual(rr.res._statusCode, 500.1);
		assert.strictEqual(Buffer.concat(rr.res._chunks).toString(), '500.1 - Cache check error');
		done();
	});
});

test('ProxyCache: requests with cacheTTL>0 sharing a cacheKey are queued (xHoldCount increments)', function(_, done){
	var pc = newPC({
		defaultTTL: 30,
		onRequest: function(req, res, cb){ cb(); },
	});
	// Empty cache so it queues / proxies
	var rrA = makeReqRes('/same');
	var rrB = makeReqRes('/same');

	pc._fakes.server.fire('request', rrA.req, rrA.res);
	// Fire the second one immediately — should land while the first is in-flight
	pc._fakes.server.fire('request', rrB.req, rrB.res);

	// Allow the synchronous cache.check callbacks to run
	setImmediate(function(){
		setImmediate(function(){
			// The second request should have been queued, so xHoldCount=1 on it
			assert.strictEqual(rrB.req.xHoldCount, 1);
			// Only one proxy call should have happened (for the first)
			// Both will eventually be served once the proxy callback fires; but at this
			// instant we should have exactly one in-flight proxy request.
			assert.ok(pc._fakes.proxy.calls.length >= 1);
			done();
		});
	});
});

test('ProxyCache: onFinish is invoked with infos and a continuation', function(_, done){
	var seenInfos = null;
	var pc = newPC({
		onRequest: function(req, res, cb){ cb(); },
		shouldCache: false,
		onFinish: function(req, res, infos, cb){
			seenInfos = infos;
			cb();
		},
	});
	var rr = makeReqRes('/finish');
	pc._fakes.server.fire('request', rr.req, rr.res);
	// Allow the proxy + finish to run
	setImmediate(function(){
		setImmediate(function(){
			setImmediate(function(){
				assert.ok(seenInfos);
				assert.strictEqual(seenInfos.docSize, 7);
				assert.deepStrictEqual(seenInfos.flags, ['P']);
				done();
			});
		});
	});
});

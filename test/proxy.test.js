"use strict";

var test   = require('node:test');
var assert = require('node:assert');
var http   = require('http');

var Proxy = require('../lib/proxy');

// --- helpers -----------------------------------------------------------------

function startEcho(handler, cb) {
	var srv = http.createServer(handler);
	srv.listen(0, '127.0.0.1', function(){
		cb(srv, srv.address().port);
	});
	return srv;
}

// A minimal response that captures writes — does not extend http.ServerResponse.
function fakeRes() {
	var r = {
		_statusCode: null,
		_headers: null,
		_chunks: [],
		_ended: false,
		_answered: null,
		statusCode: 0,
		writeHead: function(s, h){ this._statusCode = s; this._headers = h; this.statusCode = s; },
		write: function(d){ this._chunks.push(typeof d === 'string' ? Buffer.from(d) : d); },
		end: function(){ this._ended = true; },
		answer: function(status, headers, body, flags){
			this._answered = { status: status, headers: headers, body: body, flags: flags };
			this._statusCode = status;
			this.statusCode = status;
			this._ended = true;
		},
		body: function(){ return Buffer.concat(this._chunks).toString(); },
	};
	return r;
}

function fakeReq(extra) {
	var r = {
		url: '/somepath',
		method: 'GET',
		headers: {},
	};
	if (extra) for (var k in extra) r[k] = extra[k];
	return r;
}

// --- tests -------------------------------------------------------------------

test('Proxy: constructor handles missing opts', function(){
	var p = new Proxy();
	assert.deepStrictEqual(p.opts.target, undefined);
	assert.strictEqual(typeof p.opts.shouldCache, 'function');
	assert.strictEqual(p.opts.shouldCache(), true);
});

test('Proxy: constructor preserves caller-provided shouldCache', function(){
	var sc = function(){ return false; };
	var p = new Proxy({ shouldCache: sc });
	assert.strictEqual(p.opts.shouldCache, sc);
});

test('Proxy: constructor prepends http:// when target lacks a scheme', function(){
	var p = new Proxy({ target: 'example.com:9000' });
	assert.strictEqual(p.opts.target.protocol, 'http:');
	assert.strictEqual(p.opts.target.host, 'example.com:9000');
});

test('Proxy: constructor keeps https:// scheme when present', function(){
	var p = new Proxy({ target: 'https://example.com' });
	assert.strictEqual(p.opts.target.protocol, 'https:');
});

test('Proxy: constructor wires cache and outputFilter when provided', function(){
	var sentinel = {};
	var filter = function(){};
	var p = new Proxy({ cache: sentinel, outputFilter: filter });
	assert.strictEqual(p.cache, sentinel);
	assert.strictEqual(p.outputFilter, filter);
});

test('Proxy: proxyRequest throws when no target is supplied', function(){
	var p = new Proxy();
	assert.throws(function(){
		p.proxyRequest(fakeReq(), fakeRes(), null, {}, function(){});
	}, /No host\/url/);
});

test('Proxy: proxyRequest forwards request to backend and returns body (via outputFilter buffer path)', function(_, done){
	// We use an outputFilter (no-op) here so the proxy buffers + writes via the
	// fake response object rather than piping directly to it (the fake is not a Writable).
	var backend = startEcho(function(req, res){
		// target URL is "http://host:port/" so request.path resolves to "/"
		assert.strictEqual(req.url, '/');
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('hello-from-backend');
	}, function(_srv, port){
		var p = new Proxy({ outputFilter: function(data){ return data; } });
		var req = fakeReq();
		var res = fakeRes();
		p.proxyRequest(req, res, 'http://127.0.0.1:' + port + '/', {}, function(err, req2, res2, preq, pres, infos){
			assert.strictEqual(err, null);
			assert.strictEqual(res._statusCode, 200);
			assert.strictEqual(res._headers['X-Cached'], 'MISS');
			assert.strictEqual(res.body(), 'hello-from-backend');
			assert.ok(infos.flags.indexOf('P') !== -1);
			assert.strictEqual(infos.docSize, Buffer.byteLength('hello-from-backend'));
			backend.close(done);
		});
	});
});

test('Proxy: proxyRequest applies outputFilter and uses its return value as body', function(_, done){
	startEcho(function(req, res){
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('SECRET');
	}, function(srv, port){
		var p = new Proxy({
			outputFilter: function(data){ return Buffer.from('REDACTED'); },
		});
		var req = fakeReq();
		var res = fakeRes();
		p.proxyRequest(req, res, 'http://127.0.0.1:' + port + '/', {}, function(err, _q, _s, _preq, _pres, infos){
			assert.strictEqual(err, null);
			assert.strictEqual(res.body(), 'REDACTED');
			assert.strictEqual(infos.docSize, 'REDACTED'.length);
			assert.deepStrictEqual(infos.flags, ['P','F']);
			srv.close(done);
		});
	});
});

test('Proxy: proxyRequest replies 503 via res.answer on backend connection error', function(_, done){
	var p = new Proxy();
	var req = fakeReq();
	var res = fakeRes();
	// Use a port that should refuse the connection
	p.proxyRequest(req, res, 'http://127.0.0.1:1/', {}, function(err){
		assert.strictEqual(err, null);
		assert.ok(res._answered);
		assert.strictEqual(res._answered.status, 503);
		assert.deepStrictEqual(res._answered.flags, ['P','a','E']);
		done();
	});
});

test('Proxy: proxyRequest invokes opts.onError when provided instead of res.answer', function(_, done){
	var p = new Proxy();
	var req = fakeReq();
	var res = fakeRes();
	var onErrorCalled = false;
	p.proxyRequest(req, res, 'http://127.0.0.1:1/', {
		onError: function(e){ onErrorCalled = true; assert.ok(e); done(); },
	}, function(){
		// Should not be called for onError path
	});
	// Give a brief grace period in case the error doesn't fire
	setTimeout(function(){
		if ( !onErrorCalled ) done(new Error('onError was not called'));
	}, 1500);
});

test('Proxy: proxyRequest enforces timeout and calls opts.onTimeout', function(_, done){
	// Backend that never responds
	var srv = http.createServer(function(req, res){
		// hang
	});
	srv.listen(0, '127.0.0.1', function(){
		var port = srv.address().port;
		var p = new Proxy();
		var req = fakeReq();
		var res = fakeRes();
		var fired = false;
		p.proxyRequest(req, res, 'http://127.0.0.1:' + port + '/', {
			timeout: 0.1, // 100ms
			onTimeout: function(){ fired = true; srv.close(function(){ done(); }); },
		}, function(){});
		setTimeout(function(){
			if ( !fired ) { srv.close(function(){ done(new Error('timeout did not fire')); }); }
		}, 1500);
	});
});

test('Proxy: proxyRequest answers 504 when timeout fires without onTimeout', function(_, done){
	var srv = http.createServer(function(req, res){ /* hang */ });
	srv.listen(0, '127.0.0.1', function(){
		var port = srv.address().port;
		var p = new Proxy();
		var req = fakeReq();
		var res = fakeRes();
		p.proxyRequest(req, res, 'http://127.0.0.1:' + port + '/', {
			timeout: 0.1,
		}, function(err){
			assert.strictEqual(err, null);
			assert.ok(res._answered);
			assert.strictEqual(res._answered.status, 504);
			assert.deepStrictEqual(res._answered.flags, ['P','a','T']);
			srv.close(done);
		});
	});
});

test('Proxy: proxyRequest sets host header to target.host unless keepHost is set', function(_, done){
	var seenHost = null;
	var srv = http.createServer(function(req, res){
		seenHost = req.headers.host;
		res.writeHead(200, {});
		res.end('');
	});
	srv.listen(0, '127.0.0.1', function(){
		var port = srv.address().port;
		var p = new Proxy({ outputFilter: function(d){ return d; } });
		p.proxyRequest(fakeReq({ headers: { host: 'original.example' } }), fakeRes(),
			'http://127.0.0.1:' + port + '/', {}, function(){
				assert.strictEqual(seenHost, '127.0.0.1:' + port);
				srv.close(done);
			});
	});
});

test('Proxy: proxyRequest keeps original host header when keepHost is true', function(_, done){
	var seenHost = null;
	var srv = http.createServer(function(req, res){
		seenHost = req.headers.host;
		res.writeHead(200, {});
		res.end('');
	});
	srv.listen(0, '127.0.0.1', function(){
		var port = srv.address().port;
		var p = new Proxy({ outputFilter: function(d){ return d; } });
		p.proxyRequest(fakeReq({ headers: { host: 'original.example' } }), fakeRes(),
			'http://127.0.0.1:' + port + '/', { keepHost: true }, function(){
				assert.strictEqual(seenHost, 'original.example');
				srv.close(done);
			});
	});
});

test('Proxy: _debug stays silent unless debug is enabled', function(){
	var p = new Proxy();
	var origLog = console.log;
	var logged = [];
	console.log = function(){ logged.push(Array.prototype.slice.call(arguments)); };
	try {
		p._debug({ xRequestID: 'r1' }, 'should not appear');
		assert.strictEqual(logged.length, 0);
		p.debug = true;
		p._debug({ xRequestID: 'r2' }, 'visible');
		assert.strictEqual(logged.length, 1);
		assert.strictEqual(logged[0][0], 'r2');
	} finally {
		console.log = origLog;
	}
});

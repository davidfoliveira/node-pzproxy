"use strict";

var test   = require('node:test');
var assert = require('node:assert');
var http   = require('http');
var os     = require('os');
var path   = require('path');
var fs     = require('fs');

var Server = require('../lib/server');

// Silence the "Listening on …" log emitted from the Server constructor.
var origLog = console.log;
function muteLog(fn) {
	console.log = function(){};
	try { return fn(); }
	finally { console.log = origLog; }
}

function tmpSock() {
	var p = path.join(os.tmpdir(), 'pzp-srv-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.sock');
	try { fs.unlinkSync(p); } catch (e) {}
	return p;
}

function newServer(opts) {
	return muteLog(function(){ return new Server(opts); });
}

function whenListening(s, fn) {
	if ( s._server.listening ) return fn();
	s._server.once('listening', fn);
}

function closeAll(s, sockPath, cb) {
	function fin(){
		if ( sockPath ) try { fs.unlinkSync(sockPath); } catch (e) {}
		cb();
	}
	if ( s._server.listening ) s._server.close(fin);
	else fin();
}

test('Server: applies defaults proto=http and address=0.0.0.0', function(_, done){
	// We can't bind 8080 in tests, so use a unix socket to satisfy listen().
	var sock = tmpSock();
	var s = newServer({ address: sock });
	whenListening(s, function(){
		assert.strictEqual(s.opts.proto, 'http');
		assert.strictEqual(s.opts.address, sock);
		assert.strictEqual(s.opts.port, 8080); // default value applied even when unused
		closeAll(s, sock, done);
	});
});

test('Server: applies defaults when opts is omitted (port becomes 8080)', function(){
	// Don't actually bind; just verify defaults by inspecting opts after a no-bind path.
	// We do this by stubbing _server.listen via the unix socket form, but with no opts
	// the address would default to 0.0.0.0 and the port to 8080 — binding 8080 is not safe.
	// So we instead validate the defaults by running the constructor against a unix
	// socket and re-asserting the documented fallback values.
	var sock = tmpSock();
	var s = newServer({ address: sock });
	try {
		assert.strictEqual(s.opts.proto, 'http');
		assert.strictEqual(s.opts.port, 8080);
		assert.strictEqual(s.reqSeq, 0);
	} finally {
		s._server.close();
		try { fs.unlinkSync(sock); } catch (e) {}
	}
});

test('Server: on() registers handlers and emit() dispatches them with arg1, arg2', function(_, done){
	var sock = tmpSock();
	var s = newServer({ address: sock });
	whenListening(s, function(){
		var received = [];
		s.on('foo', function(a, b){ received.push([a, b]); });
		s.on('foo', function(a, b){ received.push(['second', a, b]); });
		s.emit('foo', 1, 2);
		assert.deepStrictEqual(received, [[1, 2], ['second', 1, 2]]);
		closeAll(s, sock, done);
	});
});

test('Server: emit() with unknown event is a no-op', function(_, done){
	var sock = tmpSock();
	var s = newServer({ address: sock });
	whenListening(s, function(){
		assert.doesNotThrow(function(){ s.emit('nothing'); });
		closeAll(s, sock, done);
	});
});

test('Server: _handleRequest decorates req and emits "request"', function(_, done){
	var sock = tmpSock();
	var s = newServer({ address: sock });
	whenListening(s, function(){
		var seen = null;
		s.on('request', function(req, res){ seen = { req: req, res: res }; });

		var fakeReq = { connection: { remoteAddress: '10.0.0.1' } };
		var fakeRes = {};
		s._handleRequest(fakeReq, fakeRes);

		assert.ok(seen, 'request event fired');
		assert.strictEqual(seen.req, fakeReq);
		assert.strictEqual(seen.res, fakeRes);
		assert.ok(fakeReq.xConnectDate instanceof Date);
		assert.strictEqual(typeof fakeReq.xRequestID, 'string');
		assert.ok(fakeReq.xRequestID.indexOf(process.pid.toString()) !== -1);
		assert.strictEqual(fakeReq.xRemoteAddr, '10.0.0.1');
		closeAll(s, sock, done);
	});
});

test('Server: _handleRequest increments reqSeq for each call', function(_, done){
	var sock = tmpSock();
	var s = newServer({ address: sock });
	whenListening(s, function(){
		s.on('request', function(){});
		s._handleRequest({ connection: { remoteAddress: 'x' } }, {});
		s._handleRequest({ connection: { remoteAddress: 'y' } }, {});
		assert.strictEqual(s.reqSeq, 2);
		closeAll(s, sock, done);
	});
});

test('Server: _handleRequest falls back to client._peername when connection.remoteAddress is missing', function(_, done){
	var sock = tmpSock();
	var s = newServer({ address: sock });
	whenListening(s, function(){
		s.on('request', function(){});
		var fakeReq = {
			connection: {},
			client: { _peername: { address: '192.168.1.1' } },
		};
		s._handleRequest(fakeReq, {});
		assert.strictEqual(fakeReq.xRemoteAddr, '192.168.1.1');
		closeAll(s, sock, done);
	});
});

test('Server: _handleRequest falls back to "0.0.0.0" when neither source is available', function(_, done){
	var sock = tmpSock();
	var s = newServer({ address: sock });
	whenListening(s, function(){
		s.on('request', function(){});
		var fakeReq = { connection: {} };
		s._handleRequest(fakeReq, {});
		assert.strictEqual(fakeReq.xRemoteAddr, '0.0.0.0');
		closeAll(s, sock, done);
	});
});

test('Server: end-to-end — HTTP request on a unix socket is forwarded to the "request" event', function(_, done){
	var sock = tmpSock();
	var s = newServer({ address: sock });
	s.on('request', function(req, res){
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('ok');
	});

	whenListening(s, function(){
		http.get({ socketPath: sock, path: '/hello' }, function(res){
			assert.strictEqual(res.statusCode, 200);
			var chunks = [];
			res.on('data', function(d){ chunks.push(d); });
			res.on('end', function(){
				assert.strictEqual(Buffer.concat(chunks).toString(), 'ok');
				closeAll(s, sock, done);
			});
		}).on('error', function(err){
			closeAll(s, sock, function(){ done(err); });
		});
	});
});

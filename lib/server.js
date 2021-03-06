"use strict";

var
	http  = require('http'),
	https = require('https');


// A server instance
function Server(opts) {

	var
		self = this;

	// Check options
	if ( !opts )
		opts = {};
	this.opts = opts;

	// Self properties
	self._events = {};
	self.reqSeq  = 0;

	// Self methods
	self._handleRequest = function(req,res){
		// Set some basic stuff
		var now = new Date();
		req.xConnectDate = now;
		req.xRequestID = (self.reqSeq++) + "-" + process.pid.toString() + "-" + now.getYear()+now.getMonth()+now.getDay()+now.getHours()+now.getMinutes();
		req.xRemoteAddr = req.connection.remoteAddress || ((req.client && req.client._peername) ? req.client._peername.address : "0.0.0.0");

		// Call the request handler
		self.emit('request',req,res);
	};

	// Event registering
	self.on = function(what,cb){
		if ( !self._events[what] )
			self._events[what] = [];
		self._events[what].push(cb);
	};
	self.emit = function(what,arg1,arg2){
		if ( !self._events[what] )
			return;
		self._events[what].forEach(function(cb){
			cb(arg1,arg2);
		});
	};

	// Validate options
	if ( !opts.proto )
		opts.proto = "http";
	if ( !opts.address )
		opts.address = "0.0.0.0";
	if ( !opts.port )
		opts.port = 8080;

	// Create the server
	self._server =	(opts.proto == "https")		? https.createServer(opts,_handleRequest) :
					(opts.proto == "fastcgi")	? require('fastcgi-server').createServer(_handleRequest) :
					http.createServer(self._handleRequest);

	// Start it
	if ( opts.address.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/) ) {
		console.log("Listening on "+opts.address+":"+opts.port);
		self._server.listen(opts.port, opts.address);
	}
	else {
		console.log("Listening on "+opts.address);
		self._server.listen(opts.address);
	}

	return self;

}


// Export myself
module.exports = Server;
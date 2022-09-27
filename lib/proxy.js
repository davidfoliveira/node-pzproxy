"use strict";

var
    http   = require('http'),
    https  = require('https'),
    fs     = require('fs'),
    crypto = require('crypto');


// A proxy instance
function Proxy(opts) {

    // Check our options
    if ( !opts )
        opts = {};
    this.opts = opts;

    // Debug or not debug.. that is the question
    this.debug = this.opts.debug;

    // Cache plugin
    if ( opts.cache )
        this.cache = opts.cache;

    // The function which will tell us if we chould cache or not
    if ( !opts.shouldCache )
        opts.shouldCache = function(req,res){ return true; };

    // Parse the target
    if ( opts.target ) {
        if ( !opts.target.match(/^https?:\/\//) )
            opts.target = "http://"+opts.target;
        opts.target = require('url').parse(opts.target);
    }

    if ( opts.outputFilter ) {
        this.outputFilter = opts.outputFilter
    }

    // My methods
    this.proxyRequest = proxyRequest;
    this._debug = _debug;

}


// Proxy a request
function proxyRequest(req,res,target,opts,callback){

    var
        self              = this,
        args              = Array.prototype.slice.call(arguments, 0),
        targetIsURL       = true,
        timeout           = null,
        transferTimeout   = null,
        fired             = false,
        docSize           = 0,
        request           = {},
        cacheItem         = null,
        _canHandleRequest = function() {
            if ( fired )
                return false;
            fired = true;
            if ( timeout )
                clearTimeout(timeout);
            return true;
        };

    // Get the arguments
    req         = args.shift();
    res         = args.shift();
    target      = args.shift();
    callback    = args.pop() || function(){};
    opts        = args.pop() || {};

    // Validate target
    if ( !target )
        throw new Error("No host/url to send the request");

    // Parse target
    if ( typeof target != "object" ) {
        if ( target.match(/^[^\/]+(?::(\d+))?$/) ) {
            target = "http://"+target+"/";
            targetIsURL = false;
        }
        target = require('url').parse(target);
    }

    // Options with defaults
    request = _merge(target,{
        path:    targetIsURL ? target.path : req.url,
        headers: req.headers || {},
        method:  req.method,
    },opts||{},true);

    // Delete some useless stuff
    ['cache','cacheKey','keepHost','timeout','onTimeout','onError'].forEach(function(prop){
        delete request[prop];
    });

    // Should we keep the original host header ?
    if ( !opts.keepHost )
        request.headers.host = target.host;

    // Perform the request
//    self._debug(req,"Performing request: ",JSON.stringify(request));
    var
        proto = (request.protocol == "https:") ? https : http,
        preq = proto.request(request);


    // Timeout event
    if ( opts.timeout ) {
        timeout = setTimeout(function(){
            if ( !_canHandleRequest() )
                return;
            preq.abort();
            if ( opts.onTimeout )
                return opts.onTimeout();
            res.answer(504,{'Content-type':'text/plain; charset=UTF-8'},'504 - Gateway timeout :-(',['P','a','T']);
            return callback ? callback(null,req,res,preq,null,{}) : null;
        },opts.timeout*1000);
    }

    // Should we abort on client disconnect ? We can still wait for the answer and store it in cache
    if ( self.opts.abortOnClientDisconnect ) {
        req.on('close',function(){
            if ( !_canHandleRequest() )
                return;
            preq.abort();
            return callback ? callback(null,req,res,preq,null,{docSize: null, flags: ['P','a','d']}) : null;
        });
    }


    // On response arrive
    preq.on('response',function(pres){
        if ( !_canHandleRequest() )
            return;
        if (opts.transferTimeout) {
            transferTimeout = setTimeout(function(){
                preq.abort();
            }, opts.transferTimeout);
        }
        req.xProxyGotRespHeaders = new Date();

        // Should I cache?
        if ( self.cache && self.opts.shouldCache(req,res,preq,pres) ) {
            delete pres.headers['transfer-encoding'];
            delete pres.headers['connection'];
            cacheItem = self.cache.add(opts.cacheKey || requests.path, req.cacheTTL);
            cacheItem.writeHeaders({statusCode: pres.statusCode, headers: pres.headers});
        }

        // Write the head
        pres.headers['X-Cached'] = 'MISS';
        res.writeHead(pres.statusCode,pres.headers);

        // If we have to filter the output, gather all the data, filter it and send it
        if ( typeof self.outputFilter == "function" ) {
            var allData = null;
            pres.on('data',function(data){
                var newB = new Buffer(((allData != null)?allData.length:0)+data.length);
                if ( allData != null )
                    allData.copy(newB,0,0,allData.length);
                data.copy(newB,(allData != null)?allData.length:0,0,data.length);
                allData = newB;
            });
            pres.on('end',function(){
                if (self.transferTimeout)
                    clearTimeout(self.transferTimeout);

                var d = self.outputFilter(allData,req,res,preq,pres);
                if ( d == null )
                    d = allData;
                docSize = d.length;

                // Write the data and finish it
                res.write(d);
                res.end();

                // Run the callback
                return callback ? callback(null,req,res,preq,pres,{docSize: docSize, flags: ['P','F']}) : null;
            });
        }
        else {

            // Are we caching it?
            if ( cacheItem ) {
                // Get the data and send it to cache at the same time
                docSize = 0;
                pres.on('data',function(chunk){
                    cacheItem.write(chunk);
                    res.write(chunk);
                    docSize += chunk.length;
                });
                pres.on('end',function(){
                    res.end();
                    cacheItem.end(function(){
                        // Run the callback
                        return callback ? callback(null,req,res,preq,pres,{docSize: docSize, flags: ['P']}) : null;
                    });
                });
            }
            else {
                // No cache? Just pipe it to the user!
                var pr = pres.pipe(res);
                docSize = 0;
                pres.on('data',function(chunk){
                    docSize += chunk.length;
                });
                pres.on('end',function(){
                    res.end();
                    // Run the callback
                    return callback ? callback(null,req,res,preq,pres,{docSize: docSize, flags: ['P']}) : null;
                });
            }
        }
    });
    preq.on('error',function(e){
        if ( opts.onError )
            return opts.onError(e);
        if ( !_canHandleRequest() )
            return;
        preq.abort();

        var msg = '503 - Gateway error: '+e.toString();
        res.answer(503,{'content-type':'text/plain; charset=UTF-8'},msg,['P','a','E']);
        self._debug(req,"Error performing HTTP request: ",e.toString());
        return callback ? callback(null,req,res,preq,null,{}) : null;
    });
    if ( req.headers && req.headers['content-length'] )
        req.pipe(preq);
    else
        preq.end();

};


// Debug
function _debug(req) {

    if ( !this.debug )
        return;

    var
        args = Array.prototype.slice.call(arguments, 0),
        req = args.shift();

    args.unshift(req.xRequestID);
    console.log.apply(null,args);

}

// Merge
var _merge = function(a,b,lcProps){
    var
        args = Array.prototype.slice.call(arguments, 0),
        o    = {};

    args.forEach(function(objToMerge){
        if ( typeof o != "object" )
            return;
        for ( var p in objToMerge )
            o[p] = objToMerge[p];

    });

    return o;
};


// Export myself
module.exports = Proxy;

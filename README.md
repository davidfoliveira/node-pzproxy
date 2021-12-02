# node-pzproxy 

A pluggable HTTP/HTTPS + cache + proxy library for node.js

## Installing

	npm install pzproxy

## Using it

	"use strict";

	var
	    Proxy = require('pzproxy');


	// Create a proxy instance
	new Proxy({
	    serverOpts: {
	        port: 9999
	    },
	    cacheOpts: {
	        storage: "./data"
	    },
	    proxyOpts: {
	        target: "http://www.google.pt"
	    },
	    defaultTTL: 30
	});


## Options

- `serverOpts`: The options for the default HTTP server (watch the default HTTP server options below)

- `server`: An alternative HTTP server instance

- `cacheOpts`: The options for the default cache mechanism (watch the default cache mechanism options below)

- `cache`: An alternative cache meachnism instance

- `proxyOpts`: The options for the default HTTP proxy (watch the default HTTP proxy mechanism options below)

- `proxy`: An alternative HTTP proxy instance

- `defaultTTL`: The default time-to-live (in seconds) for every request (it can be personalized by changing the req.cacheTTL property)

- `defaultTimeout`: The default backend request timeout (in seconds). The default value is: 60

- `defaultTransferTimeout`: The default timeout (in ms) for transferring data from the backend. The default value is: 60000

- `onRequest()`: Function for handling every request. The function arguments are `(request,response,callback)`

- `shouldCache()`: Function that is called to decide whether to cache or not. The function arguments are `(request,response,proxyRequest,proxyResponse)`. It should return a boolean value

- `onFinish()`: Function that is called once a request is served. The function arguments are `(request,response,callback)`

- `logAccess()`: Function that is called to log. The function arguments are `(request,response,length,flags)`

- `debug`: Activates the debug mode with a `true` value - default `false`


## Default instantes

### Default HTTP server (`server`)

- `proto`: Protocol ("http", "https" or "fastcgi") - defaults to "http";

- `address`: Address (or socket path) to bind on - defaults to "0.0.0.0";

- `port`: Port to bind on (or socket path with `proto` is "fastcgi") - defaults to 8080;


### Default cache server (`cache`)

- `storage`: Directory path where to store the cached objects;

- `cleanupInterval`: Interval of time (in seconds) to run the cleanup mechanism, removing the expired cache object files;


### Default proxy (`proxy`)

- `target`: Backend address where to send all the traffic. This parameter is optional, since you can specify a req.backendURL on the onRequest function;



## Useful request properties

By providing an `onRequest` function, you can fully customize your proxy rules. The first of the `onRequest` function arguments is `request` which is the node.js http.Server request with some extra properties:

- `cacheKey`: The cache key that will be used for storing the answer of the current request on cache (default to req.url)

- `cacheTTL`: The time-to-live (in seconds) on cache for the answer to the current request;

- `backendURL`: The URL that will be used to fetch the data to serve the current request;

- `xConnectDate`: Request arrival Date;

- `xRequestID`: Internal request ID;

- `xRemoteAddr`: Remote IP Address;

## Useful response methods

By providing an `onRequest` function, you can fully customize your proxy rules. The second of the `onRequest` function arguments is `response` which is the node.js http.Server response with some extra properties:

- answer(status,headers,data): Answers the request with the supplied status, headers and data

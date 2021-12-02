"use strict";

var
    fs     = require('fs'),
    crypto = require('crypto'),
    util   = require('util'),
    events = require('events');


// A server instance
function Cache(opts) {

    // Check options
    if ( !opts )
        opts = {};
    this.opts = opts;

    // Check storage dir
    if ( !opts.storage )
        opts.storage = opts.dir || '/tmp';

    // Cleanup interval
    if ( !opts.cleanupInterval )
        opts.cleanupInterval = 60;

    // Debug or not debug.. that is the question
    this.debug = this.opts.debug;

    // State data
    this._storedItems = {};
    this._cleaningUp = false;

    // Self methods
    this._getCacheFile     = _getCacheFile;
    this.add               = _addItem;
    this.check             = _checkItem;
    this.get               = _getItem;
    this.cleanup           = _cleanup;
    this._debug            = _debug;

    // Cleanup the cache periodically and lock while we'r doing that
    var self = this;
    this._cleanupInterval  = setInterval(function(){

        // No need to cleanup, right?
        if ( Object.keys(self._storedItems).length == 0 )
            return;

        // Lock
        if ( self._cleaningUp )
            return;
        self._cleaningUp = true;

        // Cleanup
        self.cleanup(function(){
            self._cleaningUp = false;
        });

    }, opts.cleanupInterval*1000);

};

// Get the cache file path for an item (based in it's key)
function _getCacheFile(key) {

    return this.opts.storage + '/pzp_' + _md5(key);

}


// Check if an item is cached (and not expired)
function _checkItem(key,ttl,callback) {

    var
        self = this,
        filePath = this._getCacheFile(key),
        expireDate;

    // Check if the file exists and get it's infos (stat)
    self._debug("Checking if item '"+key+"' is cached");
    return fs.stat(filePath, function(err, stat) {
            if ( err ) {
                // Cache file doesn't exist
            if ( err.code == "ENOENT" ) {
                self._debug("Item '"+key+"' is NOT cached");
                return callback(null,false);
            }
            self._debug("Error checking if item '"+key+"' is cached: ",err);
            return callback(err,null);
        }

        // Cache "file" is not a file
        if ( !stat.isFile() ) {
            self._debug("Cache 'file' '"+filePath+"' is not a file");
            return callback(new Error("Cache 'file' is not a file"),null);
        }

        // Check the expire date
        if ( ttl != null ) {
            expireDate = new Date(stat.mtime.getTime() + ttl*1000);
            if ( expireDate < new Date() ) {
                self._debug("Cache entry "+key+" has expired at "+expireDate);
                return callback(null,false);
            }
        }

        // OK!
        self._debug("Item '"+key+"' is cached!");
        return callback(null,true);
    });

}

// Get an item from cache
function _getItem(key,callback) {

    var
        self = this,
        filePath = this._getCacheFile(key);

    // Open file
    self._debug("Getting cached item '"+key+"' from '"+filePath+"'");
    return fs.open(filePath,"r",function(err,fd){
        if ( err ) {
            console.log("Error openning cache file '"+filePath+"': ",err);
            return callback(err,null);
        }

        // Read the headers
        return _getItemReadHeaders(fd,function(err,resLine){
            if ( err ) {
                console.log("Error reading cache file headers: ",err);
                return callback(err,null);
            }

            self._debug("Returning a readable stream for item '"+key+"' data...");
            return callback(null,resLine,fs.createReadStream(null,{fd:fd}));
        });
    });

}

// Read cache file headers
var _getItemReadHeaders = function(fd,callback) {

    var
        _size = new Buffer(4),
        _headers;

    // Read the header size
    fs.read(fd,_size,0,4,null,function(err,rb){
        if ( err ) {
            console.log("Error reading header size from cache file: ",err);
            return callback(err,null);
        }

        if ( rb != 4 ) {
            console.log("Couldn't read the 4 bytes of the header size from cache file");
            return callback(new Error("Couldn't read the 4 bytes of the header size from cache file"),null);
        }

        _size = _sizeBytesToNum(_size);
        _headers = new Buffer(_size);

        // Read the headers
        fs.read(fd,_headers,0,_size,null,function(err,rb){
            if ( err ) {
                console.log("Error reading cache file headers: ",err);
                return callback(err,null);
            }

            // Check the size
            if ( rb != _size ) {
                console.log("Headers size mismatch. Expecting "+_size+" and got "+rb);
                return callback(new Error("Headers size mismatch. Expecting "+_size+" and got "+rb),null);
            }

            // Parse the headers
            try {
                _headers = JSON.parse(_headers.toString());
            }
            catch(ex) {
                console.log("Error parsing headers: ",ex);
                return callback(ex,null);
            }

            // Return
            return callback(null,_headers);
        });

    });

};

// Add an item to cache
function _addItem(key, ttl) {

    var
        self = this;

    // Create a cache item and return it
    var item = new CacheItem(key, this._getCacheFile(key), ttl);
    item.on('error',function(err){
        console.log("Caching error on item '"+key+"': ",err);
    });

    // Store this item on our list, only when we finish saving it
    item.on('end', function(){
        self._storedItems[item.key] = item.expires;
    });


    return item;

}

// Cleanup (it probably should be fixed to just call the callback after all the unlinks...)
function _cleanup(callback) {

    var
        self   = this,
        now    = new Date(),
        numRem = 0;

//  console.log("Cleanup!");

    // Iterate over all the stored item and check if they are expired or not.. if they do, remove the cache file and remove it from the _storedItems list
    for ( var key in self._storedItems ) {
        if ( !self._storedItems.hasOwnProperty(key) )
            continue;

//      console.log(self._storedItems[key]+" vs "+now);
        if ( self._storedItems[key] < now ) {
            var file = self._getCacheFile(key);
            fs.unlink(file,function(err){
                if ( err ) {
                    console.log("Error removing cache file '"+file+"': ",err);
                    return;
                }
            });
            delete self._storedItems[key];
            numRem++;
        }
    }

//  if ( numRem > 0 )
//      console.log("Removed "+numRem+" expired cache entries");

    return callback();

}


// A cache item
function CacheItem(key, filePath, ttl) {

    var
        self = this;

    this.key = key;
    this.filePath = filePath;

    // Create the writable stream for this item
    self.stream = fs.createWriteStream(filePath+'.tmp');
    self.stream.on('error',function(err){
        console.log("Error writing to a temporary cache file on '"+filePath+".tmp': ",err);
        self.emit('error',err);
    });

    // Own variables and methods
    this._wroteHeaders = false;
    this._headers = {};
    this.writeHeaders = function(headers){
        if ( this._wroteHeaders ) {
            console.log("Headers already written for current cache item, ignoring...");
            return;
        }
        var strHeaders = JSON.stringify(headers);
        this.stream.write(_sizeNumToBytes(strHeaders.length));
        this.stream.write(strHeaders);
        this._wroteHeaders = true;
    };
    this.write = function(data){
        if ( !this._wroteHeaders ) {
            console.log("Headers not written for current cache item, sending the default ones...");
            this.writeHeaders({});
        }
        this.stream.write(data);
    };
    this.end = function(callback){
        this.stream.end();

        // Move the file to the final one
        return fs.rename(filePath+'.tmp',filePath,function(err){
            if ( err )
                console.log("Error renaming cache file '"+filePath+".tmp' to '"+filePath+"': ",err);

            // Reset the expire time now that the cache data is stored
            self.setExpireFromTTL(ttl);
            // Tell that we've ended and call back!
            self.emit('end');
            return callback ? callback(err) : null;
        });
    };

    // (re)Set the cache expire time based on a TTL
    this.setExpireFromTTL = function(ttl) {
        self.expires = new Date(new Date().getTime()+ttl*1000);
    };

    // Set the expire time right now (it can be useful even before storing the item)
    this.setExpireFromTTL(ttl);

};
util.inherits(CacheItem, events.EventEmitter);


// Debug
function _debug() {

    if ( !this.debug )
        return;

    var
        args = Array.prototype.slice.call(arguments, 0);

    console.log.apply(null,args);

}


/*
 Useful functions
 */

// Return the MD5 hex of a string
var _md5 = function(str) {

    return crypto.createHash('md5').update(str).digest("hex");

};

// Convert sizes to binary 32 bit little endian
function _sizeBytesToNum(data) {
    return (data[0] << 24) | (data[1] << 16) | (data[2] <<8) | data[3]
}
function _sizeNumToBytes(num,buf,offset) {
    if ( buf == null )
        buf = new Buffer(4);
    if ( offset == null )
        offset = 0;

    buf[offset+0] = (num >> 24) & 0xff;
    buf[offset+1] = (num >> 16) & 0xff;
    buf[offset+2] = (num >> 8) & 0xff;
    buf[offset+3] = num & 0xff;

    return buf;
}



// Export myself
module.exports = Cache;

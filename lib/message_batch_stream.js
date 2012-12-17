var Stream = require('stream').Stream;
var util = require('util');

/**
 * Consumes a large volume of messages, and then produces a single batch downstream
 *
 * @param {Number} opt_batchCount		Optional. Batch size to collect before streaming out. Default: 50
 * @param {Number} opt_bufferSize		Optional. Max write buffer size, in bytes. Default: 67108864 (aka 64MB)
 *
 * @constructor
 * @extends {Stream}
 */
var MessageBatchStream = function (opt_batchCount, opt_bufferSize) {
	Stream.call(this);
	this.readable = true; // large volume of messages
	this.writable = true; // one batch of messages depending on size

	/**
	 * pending data objects to flush
	 * @type {Array}
	 * @private
	 */
	this._buffer = [];

	/**
	 * Minimum number of messages to batch
	 * @type {Number}
	 * @private
	 */
	this._minBatchCount = opt_batchCount ? opt_batchCount : MessageBatchStream.BATCH_COUNT_MIN;

	/**
	 * Max write buffer size, in bytes.
	 * @type {Number}
	 * @private
	 */
	this._maxBufferSize = opt_bufferSize ? opt_bufferSize : MessageBatchStream.BUFFER_SIZE_MAX;

	/**
	 * General size of the this._buffer
	 * @type {Number}
	 * @private
	 */
	this._bufferByteCount = 0;

	/**
	 * Buffer has grown beyond this._maxBufferSize
	 * @type {Boolean}
	 * @private
	 */
	this._isOverFlow = false;

	/**
	 * @type {Boolean}
	 * @private
	 */
	this._isPaused = false;

	/**
	 * Is this batch stream open?
	 * @type {Boolean}
	 * @private
	 */
	this._isOpen = false;

	/**
	 * @type {Boolean}
	 * @private
	 */
	this._isEnded = false;

	MessageBatchStream.instances_.push(this);
};
util.inherits(MessageBatchStream, Stream);

/**
 * @const {Number}
 */
MessageBatchStream.BUFFER_SIZE_MAX = 67108864; // 64MB

/**
 * @const {Number}
 */
MessageBatchStream.BATCH_SIZE_MAX = 1048576; // 1MB

/**
 * @const {Number}
 */
MessageBatchStream.BATCH_COUNT_MIN = 50;

/**
 * All instances of MessageBatchStream
 * @type {Array.<MessageBatchStream>}
 */
MessageBatchStream.instances_ = [];

/**
 * An interval shared between all MessageBatchStream.instances_
 */
MessageBatchStream.interval_ = null;

/**
 * Count the number of open MessageBatchStream instances
 * @type {Number}
 */
MessageBatchStream.countOpen_ = 0;

/**
* Get the size of a message Object
* @param {Object} message
* @return {Number}
*/
MessageBatchStream.prototype.sizeOfMsg = function(message) {
	// increment a measure of message size, which is based mostly on htmlBody size
	if (message.htmlBody) {
		return Buffer.byteLength(message.htmlBody, 'utf8');
	} else if (message.plaintextBody) {
		return Buffer.byteLength(message.plaintextBody, 'utf8');
	} else {
		return Buffer.byteLength(message.subject, 'utf8');
	}
};

/**
 * Enqueue a message
 * @param {Object} message
 */
MessageBatchStream.prototype.enQueue = function(message) {
	this._buffer.push(message);
	this._bufferByteCount += this.sizeOfMsg(message);
};

/**
 * Dequeue a batch of up to 50 messages or 1MB
 * @return {Array}
 */
MessageBatchStream.prototype.deQueueBatch = function() {
	var subBuffer = [];
	var byteCount = 0;

	var threshold = Math.min(this._buffer.length, this._minBatchCount);
	for (var i = 0; i < threshold; i++) {
		var message = this._buffer[i];
		subBuffer.push(message);
		byteCount += this.sizeOfMsg(message);

		if (byteCount >= MessageBatchStream.BATCH_SIZE_MAX) {
			// 1MB is the limit for a batch of messages
			break;
		}
	}

	this._bufferByteCount -= byteCount;
	this._buffer = this._buffer.slice(subBuffer.length);
	return subBuffer;
};

/**
 * Start the interval
 */
MessageBatchStream.prototype._start = function() {
	if (!this._isOpen) {
		this._isOpen = true;
		++MessageBatchStream.countOpen_;
	}

	if (!MessageBatchStream.interval_) {
		MessageBatchStream.interval_ = setInterval(MessageBatchStream.interval_, 5);
	}
};

/**
 * Stop the interval
 */
MessageBatchStream.prototype._stop = function() {
	if (this._isOpen) {
		this._isOpen = false;
		--MessageBatchStream.countOpen_;
	}

	if (MessageBatchStream.countOpen_ === 0) {
		clearInterval(MessageBatchStream.interval_);
		MessageBatchStream.interval_ = null
	}
};

/**
 * Is this stream active?
 * @return {Boolean}
 */
MessageBatchStream.prototype.isActive = function() {
	return !this._isPaused && this._isOpen;
};

MessageBatchStream._onTickAll = function() {
	MessageBatchStream.instances_.forEach(function(msgBatchStream) {
		if (msgBatchStream.isActive()) {
			msgBatchStream.onTick(msgBatchStream);
		}
	});
};

/**
 * Called on an interval
 */
MessageBatchStream.prototype.onTick = function() {
	if (!this.isActive()) {
		if (this._isOverFlow) {
			console.warn(this.name || 'MessageBatchStream', ' is inactive and is overflowing!')
		}
		return;
	}

	var batch = this.deQueueBatch();
	if (batch.length) {
		this.emit('data', batch);
	} else {
		this.emit('drain');
	}

	if (this._isEnded && this._buffer.length === 0) {
		// last bit of data
		this.emit('end');
		this._stop();
	}
};

/**
* Called from an upstream Stream
* NOTE: message may contain:
* 		subject			(required) a string containing the email's subject line
* 		plaintextBody	(optional)	a string containing the plaintext message body.
* 		htmlBody		(optional)	a string containing the HTML message body.
*
* @param {Object} message
* @return {Boolean}			False if we should pause the writing to this stream.
*/
MessageBatchStream.prototype.write = function(message) {
	this.enQueue(message);
	this._start();

	// don't overflow! this will ask upstream to pause
	this._isOverFlow = this._bufferByteCount > this._maxBufferSize;
	return !this._isOverFlow;
};

/**
* Pause producing data
*/
MessageBatchStream.prototype.pause = function() {
	if (this._isPaused) {
		return;
	}

	this._stop();
	this._isPaused = true;
	this.emit('pause');
};

/**
* Resume producing data
*/
MessageBatchStream.prototype.resume = function() {
	if (!this._isPaused) {
		return;
	}

	this._isPaused = false;
	this._start();
	this.emit('resume');
};

/**
* No more data will be written to this stream
*/
MessageBatchStream.prototype.end = function() {
	this._isEnded = true;
};

/**
 * Close the writable stream
 */
MessageBatchStream.prototype.destroy = function() {
	this.write = function() {};
	this._stop();
	this.emit('close');
};

module.exports = MessageBatchStream;
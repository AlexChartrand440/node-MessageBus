var Stream = require('stream').Stream;
var util = require('util');

/**
 * Consumes a large volume of messages, and then produces a single batch downstream
 *
 * @param {Number} opt_batchCount		Optional. Batch size to collect before streaming out.
 * @param {Number} opt_bufferSize		Optional. Max buffer size, in bytes, before pausing.
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
	 * Max buffer size, in bytes, before pausing.
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
	 * An interval
	 * @type {*}
	 * @private
	 */
	this._interval = undefined;

	/**
	 * @type {Boolean}
	 * @private
	 */
	this._isPaused = false;
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

	var threshold = Math.min(this._buffer.length, 50);
	for (var i = 0; i < threshold; i++) {
		var message = this._buffer[i];
		subBuffer.push(message);
		byteCount += this.sizeOfMsg(message);

		if (byteCount >= MessageBatchStream.BATCH_SIZE_MAX) {
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
	if (!this._isPaused && !this._interval) {
		this._interval = global.setInterval(this._onTick.bind(this), 50);
	}
};
/**
 * Stop the interval
 */
MessageBatchStream.prototype._stop = function() {
	if (this._interval) {
		global.clearInterval(this._interval);
		this._interval = undefined;
	}
};

/**
 * @private
 */
MessageBatchStream.prototype._onTick = function() {
	if (this._buffer.length < this._minBatchCount) {
		return;
	}

	var batch = this.deQueueBatch();
	if (batch.length) {
		this.emit('data', batch);
		if (this._buffer.length === 0) {
			this.emit('drain');
		}
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

	return this._bufferByteCount <= this._maxBufferSize;
};

/**
* Pause
*/
MessageBatchStream.prototype.pause = function() {
	this._stop();
	this._isPaused = true;
	this.emit('pause');
};

/**
* Resume
*/
MessageBatchStream.prototype.resume = function() {
	this._isPaused = false;
	this._start();
	this.emit('resume');
};

/**
* Called when there is no more data to write
*/
MessageBatchStream.prototype.end = function(message) {
	this.enQueue(message);
	this._minBatchCount = 0;
	this.emit('end');
	this.once('drain', this._stop.bind(this));
};

module.exports = MessageBatchStream;
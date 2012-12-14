var Stream = require('stream').Stream;
var util = require('util');

/**
 * Consumes messages and sends them through a MsgBusClient
 *
 * @param {MsgBusClient} client						The client to send batches through
 * @param {Number=} opt_maxConcurrentRequests		Optional. The maximum number of pending concurrent requests allowed
 *
 * @constructor
 * @extends {Stream}
 */
var MessageSendStream = function (client, opt_maxConcurrentRequests) {
	Stream.call(this);
	this.readable = false; // large volume of messages
	this.writable = true; // one batch of messages depending on size

	/**
	 * @type {MsgBusClient}
	 * @private
	 */
	this._client = client;

	/**
	 * The number of pending concurrent requests
	 * @type {Number}
	 * @private
	 */
	this._countConcurrentRequests = 0;

	/**
	 * The maximum number of concurrent pending requests
	 * @type {Number=}
	 * @private
	 */
	this._maxConcurrentRequests = opt_maxConcurrentRequests ? opt_maxConcurrentRequests : MessageSendStream.MAX_PENDING;

	/**
	 * Successes
	 * @type {Number}
	 */
	this.successCount = 0;

	/**
	 * Failures
	 * @type {Number}
	 */
	this.failureCount = 0;

	/**
	 * @type {Boolean}
	 * @private
	 */
	this._isThrottled = false;

	/**
	 * @type {Boolean}
	 * @private
	 */
	this._isEnded = false;
};
util.inherits(MessageSendStream, Stream);

/**
 * @const {Number}
 */
MessageSendStream.MAX_PENDING = 50;

/**
* Called from an upstream Stream
*
* @param {Array.<Object>} messages
* @return {Boolean}			False if we should pause the writing to this stream.
*/
MessageSendStream.prototype.write = function(messages) {
	++this._countConcurrentRequests;
	this._client.sendEmailBatch(messages, this._onSendBatchResponse.bind(this));
	return this._countConcurrentRequests < this._maxConcurrentRequests;
};

/**
* Called when there is no more data to write
*/
MessageSendStream.prototype.end = function() {
	this._isEnded = true;
};

/**
* Called to destroy the send stream
*/
MessageSendStream.prototype.destroy = function() {
	this.write = function() {};
	this.emit('close');
};

/**
 * @param {Error} err
 * @param {Object} resp
 * @private
 */
MessageSendStream.prototype._onSendBatchResponse = function(err, resp) {
	if (err) {
		this.emit('error', err);
	} else if (resp) {
		this.successCount += resp['successCount'] ? resp['successCount'] : 0;
		this.failureCount += resp['failureCount'] ? resp['failureCount'] : 0;
	}

	--this._countConcurrentRequests;
	if (this._countConcurrentRequests === 0) {
		this.emit('drain');
		if (this._isEnded) {
			this.emit('close');
		}
	}
};

module.exports = MessageSendStream;
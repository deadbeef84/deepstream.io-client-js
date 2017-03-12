'use strict'

module.exports = {
  /**
   * @param {Number} heartBeatInterval           How often you expect the heartbeat to be sent.
   *                                             If two heatbeats are missed in a row the client
   *                                             will consider the server to have disconnected
   *                                             and will close the connection in order to
   *                                             establish a new one.
   */
  heartbeatInterval: 30000,

  /**
   * @param {Number} reconnectIntervalIncrement  Specifies the number of milliseconds by
   *                                             which the time until the next reconnection
   *                                             attempt will be incremented after every
   *                                             unsuccesful attempt.
   *                                             E.g. for 1500: if the connection is lost,
   *                                             the client will attempt to reconnect immediatly,
   *                                             if that fails it will try again after 1.5 seconds,
   *                                             if that fails it will try again after 3 seconds
   *                                             and so on
   */
  reconnectIntervalIncrement: 4000,

  /**
   * @param {Number} maxReconnectInterval        Specifies the maximum number of milliseconds for
   *                                             the reconnectIntervalIncrement
   *                                             The amount of reconnections will reach this value
   *                                             then reconnectIntervalIncrement will be ignored.
   */
  maxReconnectInterval: 180000,

  /**
   * @param {Number} maxReconnectAttempts        The number of reconnection attempts until the
   *                                             client gives up and declares the connection closed
   */
  maxReconnectAttempts: 5,

  /**
   * @param {Number} rpcAckTimeout               The number of milliseconds after which a rpc will
   *                                             create an error if no Ack-message has been received
   */
  rpcAckTimeout: 15000,

  /**
   * @param {Number} rpcResponseTimeout          The number of milliseconds after which a rpc will
   *                                             create an error if no response-message has been
   *                                             received
   */
  rpcResponseTimeout: 15000,

  /**
   * @param {Number} subscriptionTimeout         The number of milliseconds that can pass after
   *                                             providing/unproviding a RPC or subscribing/
   *                                             unsubscribing/listening to a record before an
   *                                             error is thrown
   */
  subscriptionTimeout: 2000,

  /**
   * @param {Number} maxMessagesPerPacket        If the implementation tries to send a large
   *                                             number of messages at the same time, the deepstream
   *                                             client will try to split them into smaller packets
   *                                             and send these every
   *                                             <timeBetweenSendingQueuedPackages> ms.
   *
   *                                             This parameter specifies the number of messages
   *                                             after which deepstream sends the packet and
   *                                             queues the remaining messages.
   *                                             Set to Infinity to turn the feature off.
   *
   */
  maxMessagesPerPacket: 100,

  /**
   * @param {String} path path to connect to
   */
  path: '/deepstream'
}

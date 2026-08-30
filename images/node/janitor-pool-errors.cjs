"use strict";

// pg-pool removes a disconnected idle client before emitting this event. Do not
// replace active-query rejection, retry statements, or install process handlers.
function attachJanitorPoolErrorHandler(pool, logger) {
  pool.on("error", (error) => {
    // pg-pool attaches the client (and its connection configuration) to errors.
    // Record only a bounded SQLSTATE; never serialize the error/client/message.
    const code = typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)
      ? error.code : "UNKNOWN";
    logger.error("CyclotronV2Janitor idle PostgreSQL client disconnected", { code });
  });
}

module.exports = { attachJanitorPoolErrorHandler };

"use strict";
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

if (process.platform === "win32") {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function spawnWithoutConsole(command, args, options) {
    if (Array.isArray(args)) {
      return originalSpawn.call(this, command, args, {
        ...options,
        windowsHide: true,
      });
    }

    return originalSpawn.call(this, command, {
      ...args,
      windowsHide: true,
    });
  };

  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function spawnSyncWithoutConsole(
    command,
    args,
    options
  ) {
    if (Array.isArray(args)) {
      return originalSpawnSync.call(this, command, args, {
        ...options,
        windowsHide: true,
      });
    }

    return originalSpawnSync.call(this, command, {
      ...args,
      windowsHide: true,
    });
  };

  const originalFork = childProcess.fork;
  childProcess.fork = function forkWithoutConsole(modulePath, args, options) {
    if (Array.isArray(args)) {
      return originalFork.call(this, modulePath, args, {
        ...options,
        windowsHide: true,
      });
    }

    return originalFork.call(this, modulePath, {
      ...args,
      windowsHide: true,
    });
  };

  syncBuiltinESMExports();
}

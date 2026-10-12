#!/usr/bin/env node

if (process.argv.length <= 2) process.argv.push("tray");
require("./cli-launcher.cjs");

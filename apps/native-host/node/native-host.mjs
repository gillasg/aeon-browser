#!/usr/bin/env node
import { main } from "./host.mjs";

process.exitCode = await main();

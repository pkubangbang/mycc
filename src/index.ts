#!/usr/bin/env node
/**
 * index.ts - Entry point for the coding agent
 */

import 'dotenv/config';
import { main } from './loop/agent-loop.js';

main().catch(console.error);
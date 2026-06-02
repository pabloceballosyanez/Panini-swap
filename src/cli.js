#!/usr/bin/env node
import { handleMessage } from './bot.js';

const args = process.argv.slice(2);

if (args.length < 3) {
  console.log('Uso: node src/cli.js <contact_id> <name> <channel> <message...>');
  console.log('Ej: node src/cli.js 8604770039 "Pablo" telegram "tengo ARG1 ARG2"');
  process.exit(1);
}

const contactId = args[0];
const name = args[1];
const channel = args[2];
const message = args.slice(3).join(' ');

const response = await handleMessage(contactId, name, channel, message);
console.log(response);

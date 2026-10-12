import { EventEmitter } from 'node:events';
import { trackNativeProcess } from '../../src/generation/core/native-processes.ts';

class ControlledChild extends EventEmitter {
  kill(received) {
    console.log(JSON.stringify({ type: 'mock-child-kill', received }));
    globalThis.queueMicrotask(() => this.emit('exit', null, received));
    return true;
  }
}
const [order, signal, owner] = process.argv.slice(2);
const alignment = new ControlledChild();
const irodori = new ControlledChild();
if (order === 'alignment-first') trackNativeProcess(alignment);
trackNativeProcess(irodori);
if (order === 'irodori-first') trackNativeProcess(alignment);
if (owner === 'owner-exits') process.once(signal, () => process.exit(0));
if (owner === 'owner-keeps-running') process.once(signal, () => console.log(JSON.stringify({ type: 'host-handled' })));
console.log(JSON.stringify({ type: 'ready', order, signal, owner, listeners: process.listenerCount(signal) }));
globalThis.setInterval(() => {}, 1000);

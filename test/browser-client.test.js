const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Exercise the browser adapter without pretending this replaces a real file:// browser test. */
test('hosted adapter defers connect, disables cookies and owns optional reconnect registration', async () => {
    const emitted=[],handlers={},calls=[];
    const socket={on:(name,fn)=>{handlers[name]=fn;},emit:(...args)=>emitted.push(args),connect:()=>calls.push('connect')};
    const window={__TBN_SERVER_URL__:'https://open.thisagentmd.com',io:(url,options)=>{calls.push({url,options});return socket;}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../modules/server/public/tbn-client.js'),'utf8'),{window,queueMicrotask});
    const actor={name:'Prepared actor'};
    assert.equal(window.TBN.connect({actor}),socket);
    assert.equal(calls.length,1);assert.equal(calls[0].url,'https://open.thisagentmd.com');
    assert.equal(calls[0].options.path,'/socket.io');assert.equal(calls[0].options.withCredentials,false);
    assert.equal(calls[0].options.autoConnect,false);
    await Promise.resolve();assert.equal(calls[1],'connect');
    handlers.connect();handlers.connect();assert.equal(emitted.length,2);
    assert.equal(emitted[0][0],'register_actor');assert.equal(emitted[0][1],actor);
    window.TBN.connect({url:'http://localhost:4000',autoConnect:false});await Promise.resolve();
    assert.equal(calls.filter(c=>c==='connect').length,1);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Copy deployment inputs into an isolated fixture with a gcloud stub; never deploy or read real credentials. */
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tserver-deploy-'));
    t.after(() => fs.rmSync(directory, {recursive:true,force:true}));
    const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
    for (const name of ['deploy.sh','.gitignore','.dockerignore','.gcloudignore']) fs.copyFileSync(path.join(__dirname,'..',name),path.join(directory,name));
    const audit = path.join(directory,'audit.json');
    fs.writeFileSync(path.join(bin,'gcloud'), `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='auth')process.exit(0);
if(args[0]==='run'&&args[1]==='deploy'){
 const filename=args[args.indexOf('--flags-file')+1];
 const flags=JSON.parse(fs.readFileSync(filename,'utf8'));
 const token=flags['--update-env-vars'].ADMIN_TOKEN;
 fs.writeFileSync(process.env.DEPLOY_TEST_AUDIT,JSON.stringify({
   secureMode:(fs.statSync(filename).mode&511)===384,
   validToken:/^[0-9a-f]{64}$/.test(token),
   leakedInArguments:args.some(arg=>arg.includes(token)),
   usesUpdate:!!flags['--update-env-vars'],
   project:args[args.indexOf('--project')+1],
   publicUrl:flags['--update-env-vars'].PUBLIC_GAME_URL,
   publicAccess:args.includes('--allow-unauthenticated'),
   maxInstances:args[args.indexOf('--max-instances')+1],
   timeout:args[args.indexOf('--timeout')+1]
 }));
 process.exit(Number(process.env.DEPLOY_TEST_EXIT||0));
}
if(args[0]==='run'&&args[1]==='services')console.log('https://example.invalid');
`,{mode:0o755});
    return {directory,audit,env:{...process.env,PATH:`${bin}${path.delimiter}${process.env.PATH}`,DEPLOY_TEST_AUDIT:audit,PROJECT_ID:'test-project',PUBLIC_GAME_URL:'https://open.thisagentmd.com'}};
}

test('deployment creates an owner-only ignored admin secret and passes it through a flags file', t => {
    const f=fixture(t);
    const result=spawnSync('bash',[path.join(f.directory,'deploy.sh')],{cwd:os.tmpdir(),env:f.env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const secretFile=path.join(f.directory,'.admin-secret.tmp'), secret=fs.readFileSync(secretFile,'utf8').trim();
    assert.ok(/^[0-9a-f]{64}$/.test(secret)); assert.equal(fs.statSync(secretFile).mode&0o777,0o600);
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    const audit=JSON.parse(fs.readFileSync(f.audit,'utf8'));
    assert.deepEqual(audit,{secureMode:true,validToken:true,leakedInArguments:false,usesUpdate:true,project:'test-project',publicUrl:'https://open.thisagentmd.com',publicAccess:true,maxInstances:'1',timeout:'3600'});
    assert.deepEqual(fs.readdirSync(f.directory).filter(name=>name.startsWith('.admin-')),['.admin-secret.tmp']);
    for(const name of ['.gitignore','.dockerignore','.gcloudignore']){
        const text=fs.readFileSync(path.join(f.directory,name),'utf8');
        assert.ok(text.includes('.admin-secret.tmp*') && text.includes('.admin-deploy-flags.tmp*'));
    }
});

test('failed deployment preserves the current admin secret and removes pending credential files', t => {
    const f=fixture(t), secretFile=path.join(f.directory,'.admin-secret.tmp');
    fs.writeFileSync(secretFile,'previous-secret\n',{mode:0o600});
    const result=spawnSync('bash',[path.join(f.directory,'deploy.sh')],{env:{...f.env,DEPLOY_TEST_EXIT:'7'},encoding:'utf8'});
    assert.equal(result.status,7);
    assert.equal(fs.readFileSync(secretFile,'utf8'),'previous-secret\n');
    assert.deepEqual(fs.readdirSync(f.directory).filter(name=>name.startsWith('.admin-')),['.admin-secret.tmp']);
});

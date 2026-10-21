/** Git 子进程的固定协议 helper；capability、账号和令牌不写入文件。 */
export const gitCredentialHelperSource = String.raw`
const http=require('node:http'),cp=require('node:child_process');
const git=process.env.LCODE_GIT_BINARY||'git';
async function request(url,transport){
 let cwd=cp.spawnSync(git,['rev-parse','--show-toplevel'],{encoding:'utf8',windowsHide:true}).stdout?.trim();
 if(!cwd&&process.env.GIT_DIR){const dir=cp.spawnSync(git,['rev-parse','--absolute-git-dir'],{encoding:'utf8',windowsHide:true}).stdout?.trim();if(dir){const path=require('node:path');cwd=path.basename(dir)==='.git'?path.dirname(dir):dir}}
 const body=JSON.stringify({cwd:cwd||process.cwd(),url,transport});
 return new Promise((resolve,reject)=>{
  const endpoint=new URL(process.env.LCODE_GIT_HELPER_ENDPOINT);
  if(endpoint.hostname!=='127.0.0.1'||endpoint.protocol!=='http:')return reject(new Error('git-account-helper-unavailable'));
  const req=http.request(endpoint,{method:'POST',headers:{authorization:'Bearer '+process.env.LCODE_GIT_HELPER_CAPABILITY,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
   let text='';res.on('data',c=>{text+=c;if(text.length>65536)req.destroy(new Error('git-account-helper-unavailable'))});
   res.on('end',()=>{try{if(res.statusCode!==200)throw 0;resolve(JSON.parse(text))}catch{reject(new Error('git-account-helper-unavailable'))}});
  });req.setTimeout(60000,()=>req.destroy(new Error('git-account-helper-unavailable')));req.on('error',reject);req.end(body);
 });
}
(async()=>{
 const mode=process.argv[2],args=process.argv.slice(3);
 if(mode==='http'){
  if(args[0]!=='get')return;
  let input='';for await(const c of process.stdin){input+=c;if(input.length>65536)throw 0}
  const fields=Object.fromEntries(input.split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)]}));
  const url=new URL(fields.url||fields.protocol+'://'+fields.host+'/'+(fields.path||''));
  if(fields.username)url.username=fields.username;
  const result=await request(url.href,'http');
  if(result.kind!=='http')throw new Error(result.error||'git-account-credential-unavailable');
  if(/[\r\n\0]/.test(result.username+result.password))throw 0;
  process.stdout.write('username='+result.username+'\npassword='+result.password+'\n\n');
 }else if(mode==='ssh'){
  const command=args.at(-1)||'',dest=args.at(-2)||'';
  const match=command.match(/^(?:git-upload-pack|git-receive-pack|git-upload-archive) '(.+)'$/);
  if(!match||dest.startsWith('-'))throw new Error('git-account-ssh-target-unavailable');
  const path=match[1].replace(/'\\''/g,"'");
  const url=new URL('ssh://'+dest+'/'+path.replace(/^\//,''));
  const port=args.indexOf('-p');if(port>=0)url.port=args[port+1];
  const result=await request(url.href,'ssh');
  if(result.kind!=='ssh')throw new Error(result.error||'git-account-credential-unavailable');
  const selected=result.privateKeyPath?['-o','IdentitiesOnly=yes','-i',result.privateKeyPath]:[];
  const configured=process.env.LCODE_GIT_ORIGINAL_SSH_COMMAND||cp.spawnSync(git,['config','--get','core.sshCommand'],{encoding:'utf8',windowsHide:true}).stdout?.trim();
  const sshArgs=['-o','BatchMode=yes',...selected,...args];
  const child=configured?cp.spawn(git,['-c','alias.lcode-auth-ssh=!'+configured,'lcode-auth-ssh',...sshArgs],{stdio:'inherit',windowsHide:true}):cp.spawn(process.env.LCODE_GIT_ORIGINAL_SSH||'ssh',sshArgs,{stdio:'inherit',windowsHide:true});
  child.on('error',()=>{process.stderr.write('git-account-ssh-unavailable\n');process.exitCode=1});
  child.on('exit',code=>{process.exitCode=code??1});
 }else throw 0;
})().catch(error=>{const code=/^git-[a-z-]+$/.test(error?.message)?error.message:'git-account-helper-unavailable';process.stderr.write(code+'\nSelect or reload the repository account in Git > Remotes, then explicitly retry the Git operation.\n');process.exitCode=1});
`;

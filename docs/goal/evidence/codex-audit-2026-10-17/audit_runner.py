from pathlib import Path
import os, subprocess, json, time, shlex
OUT=Path(__file__).resolve().parent
ROOT=OUT/'snapshots/head'
ENV={k:os.environ[k] for k in ('PATH','LANG','LC_ALL') if k in os.environ}
ENV.update(PYTHONDONTWRITEBYTECODE='1',PYTHONPATH='src',TMPDIR=str(OUT/'tmp'),ROCO_LOCAL_MODEL='off')
(OUT/'tmp').mkdir(exist_ok=True)
def run(label,args,cwd=ROOT,timeout=90):
    start=time.monotonic()
    try:
        p=subprocess.run(args,cwd=cwd,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
        code=p.returncode; output=p.stdout
    except subprocess.TimeoutExpired as e:
        code=124;output=(e.stdout or b'')+b'\nTIMEOUT\n'
    (OUT/'logs'/f'{label}.log').write_bytes(output)
    row={'label':label,'cwd':str(cwd),'command':shlex.join(args),'env':{'PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':'src','ROCO_LOCAL_MODEL':'off'},'exit_code':code,'elapsed_s':round(time.monotonic()-start,3),'log':f'logs/{label}.log'}
    with (OUT/'commands.jsonl').open('a') as f:f.write(json.dumps(row,ensure_ascii=False)+'\n')
    print(json.dumps(row,ensure_ascii=False),flush=True)
    return code
if __name__=='__main__':
    run('head-python',['python3','-m','unittest','tests.test_type_multiplier_ruling','tests.test_scarlett_bad_cases','-v'],ROOT/'roco')
    run('head-node',['node','--test','tests/roco-rag-typechart.test.js','tests/roco-scarlett-tier-grounding.test.js','tests/roco-type-multiplier-ask.test.js'])

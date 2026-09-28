import argparse,json
from pathlib import Path
from transformers import AutoTokenizer

parser=argparse.ArgumentParser()
parser.add_argument('data')
parser.add_argument('--max-seq-length',type=int,default=1024)
args=parser.parse_args()
tok=AutoTokenizer.from_pretrained('/Users/serendizc/Developer/roco-coach/.models/mlx/Qwen3.5-4B-4bit',local_files_only=True)
bad=0
for split in ['train','valid','test']:
    rows=[json.loads(x) for x in (Path(args.data)/(split+'.jsonl')).read_text().splitlines() if x.strip()]
    lengths=[];no_answer=0;cuts=0
    for row in rows:
        m=row['messages']
        full=tok.apply_chat_template(m,return_dict=False)
        prefix=tok.apply_chat_template(m[:-1],add_generation_prompt=True,return_dict=False)
        lengths.append(len(full));cuts+=len(full)>args.max_seq_length;no_answer+=len(prefix)>=args.max_seq_length
    bad+=cuts
    print(json.dumps({'split':split,'samples':len(rows),'max_tokens':max(lengths,default=0),'p95_tokens':sorted(lengths)[int(.95*(len(lengths)-1))] if lengths else 0,'would_truncate':cuts,'prompt_fills_budget':no_answer},ensure_ascii=False))
print('Train prefix default and serving enable_thinking=False differ; inspect masking/template consistency before formal training.')
raise SystemExit(2 if bad else 0)

"""Small, actual LM-output-head policy-gradient experiment; never controls the live coach."""
import os,json,time
from pathlib import Path
os.environ['HF_HOME']=str(Path('.models').resolve());os.environ['HF_HUB_DISABLE_XET']='1'
import torch
from transformers import AutoTokenizer,AutoModelForCausalLM
model_id='HuggingFaceTB/SmolLM2-135M-Instruct'
torch.set_num_threads(2)
tokenizer=AutoTokenizer.from_pretrained(model_id,trust_remote_code=False)
model=AutoModelForCausalLM.from_pretrained(model_id,trust_remote_code=False).eval()
for p in model.parameters():p.requires_grad_(False)
# Read-state questions require changing battle facts; search-rules questions require static mechanics.
groups={
 'train':[
 ('How much health does my fox have now?',0),('Which pet is currently active?',0),('How many healing potions remain?',0),('What energy does the enemy have right now?',0),('Which of my partners are still alive?',0),('Is my turtle poisoned at this moment?',0),('Who is my opponent on the field?',0),('What is the current turn number?',0),('How much HP has the deer left?',0),('Does my active pet have enough beans right now?',0),('Show the current team health.',0),('Is the match over already?',0),
 ('Does switching use the whole turn?',1),('Does a benched pet regenerate energy?',1),('What does burn do?',1),('Which element counters water?',1),('How is damage calculated?',1),('What happens if speeds are equal?',1),('Can guard be used twice in a row?',1),('How does the healing item work?',1),('Does poison tick while benched?',1),('What determines action priority?',1),('How does forced replacement work?',1),('Does switching remove a status effect?',1)],
 'validation':[
 ('Tell me the remaining HP of every teammate.',0),('How many energy fruits are in my bag?',0),('Is my current enemy still burning?',0),('Are there living reserves on my side?',0),
 ('Explain the rule for speed ties.',1),('When is energy restored each round?',1),('What is the cost of voluntary switching?',1),('Which attacks pierce guarding?',1)],
 'test':[
 ('Read the health bar of the pet fighting for me.',0),('Count my unused medicine in this battle.',0),('Check whether the enemy has zero energy.',0),('Identify the animal presently facing me.',0),('List my knocked-out companions.',0),('Check my team before recommending a replacement.',0),('What status is attached to my current companion?',0),('Tell me which round we have reached.',0),
 ('I do not understand why an item goes before a quick pet.',1),('Explain how elemental resistance changes a hit.',1),('Can I attack immediately after a voluntary swap?',1),('What are the rules for poison on a reserve?',1),('Describe the effect of using guard.',1),('What does the cleanse item remove?',1),('Explain how recoil is resolved.',1),('Is a replacement after a knockout a normal turn?',1)]}
Path('tests/evals/tool-router.json').write_text(json.dumps(groups,indent=2))
ids=[tokenizer.encode(x,add_special_tokens=False) for x in ['A','B']];assert all(len(x)==1 for x in ids);ids=[x[0] for x in ids]
features={};labels={}
for split,rows in groups.items():
 vec=[]
 for q,y in rows:
  prompt=tokenizer.apply_chat_template([{'role':'system','content':'Choose one read-only game-coach tool. A = read_state for the current battle. B = search_rules for game mechanics. Reply with only A or B.'},{'role':'user','content':q}],tokenize=True,add_generation_prompt=True,return_tensors='pt')
  with torch.no_grad():vec.append(model.model(input_ids=prompt).last_hidden_state[0,-1].float().cpu())
 features[split]=torch.stack(vec);labels[split]=torch.tensor([y for _,y in rows])
initial=model.lm_head.weight[ids].float().detach().clone()
reports=[];trajectories=[];checkpoints=[]
def evaluate(w,split):
 with torch.no_grad():pred=(features[split]@w.T).argmax(-1);return {'n':len(pred),'accuracy':float((pred==labels[split]).float().mean()),'predictions':pred.tolist()}
for seed in [17,71,199]:
 torch.manual_seed(seed);weights=torch.nn.Parameter(initial.clone());opt=torch.optim.Adam([weights],lr=.002);curve=[];best=(-1,None,0)
 with torch.no_grad():reference=(features['train']@initial.T).softmax(-1)
 for epoch in range(250):
  logits=features['train']@weights.T;policy=torch.distributions.Categorical(logits=logits);actions=policy.sample()
  rewards=(actions==labels['train']).float()*2-1
  advantage=rewards-rewards.mean();logp=policy.log_prob(actions)
  kl=(policy.probs*(policy.probs.clamp_min(1e-8).log()-reference.clamp_min(1e-8).log())).sum(-1).mean()
  loss=-(logp*advantage.detach()).mean()+.01*kl
  opt.zero_grad();loss.backward();torch.nn.utils.clip_grad_norm_([weights],1);opt.step()
  trajectories.append({'seed':seed,'epoch':epoch,'actions':actions.tolist(),'rewards':rewards.tolist(),'loss':float(loss.detach())})
  if (epoch+1)%10==0:
   val=evaluate(weights,'validation')['accuracy'];curve.append({'epoch':epoch+1,'reward':float(rewards.mean()),'validationAccuracy':val})
   if val>best[0]:best=(val,weights.detach().clone(),epoch+1)
 chosen=best[1];reports.append({'seed':seed,'selectedEpoch':best[2],'validation':evaluate(chosen,'validation'),'test':evaluate(chosen,'test'),'curve':curve,'parameterDeltaL2':float((chosen-initial).norm())});checkpoints.append({'seed':seed,'weights':chosen})
Path('checkpoints').mkdir(exist_ok=True)
torch.save({'model':model_id,'tokenIds':ids,'initialRows':initial,'checkpoints':checkpoints,'method':'REINFORCE on two allowed LM output rows; backbone frozen'},'checkpoints/tool-router-head.pt')
Path('reports/tool-router-trajectories.jsonl').write_text('\n'.join(json.dumps(x) for x in trajectories)+'\n')
report={'model':model_id,'revision':getattr(model.config,'_commit_hash',None),'method':'REINFORCE with batch baseline and KL regularization','trainableParameters':initial.numel(),'tools':['read_state','search_rules'],'data':{k:len(v) for k,v in groups.items()},'untrained':evaluate(initial,'test'),'alwaysReadStateAccuracy':.5,'runs':reports,'scope':'Hand-authored English binary tool-choice bandit. Cached frozen LM features, trained two output rows. Actual parameter updates; not multi-step Agent Lightning, not DeepSeek finetuning, not proof of player learning. All test prompts excluded from training and checkpoint selection.'}
Path('reports/tool-router-rl.json').write_text(json.dumps(report,indent=2));print(json.dumps({**{k:v for k,v in report.items() if k!='runs'},'runs':[{k:v for k,v in r.items() if k!='curve'} for r in reports]},indent=2))

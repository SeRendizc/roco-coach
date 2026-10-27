from pathlib import Path
import sys,json
from unittest import mock
root=Path(sys.argv[1]).resolve()
sys.path.insert(0,str(root/'roco/src'))
from roco_env import data
from roco_env.service import RocoService
rs=data.load_ruleset();svc=RocoService()
pid=next(pid for pid,p in rs.pets.items() if set(p.types)=={'翼系','水系'})
summary=svc._answer_weakness_summary(rs,{'pet_ids':[pid]}).result
with mock.patch.object(data.TypeChart,'multiplier',return_value=1.0):
 neutral=svc._answer_weakness_summary(rs,{'pet_ids':[pid]}).result
print(json.dumps({'type_multiplier':svc._answer_type_multiplier(rs,{'defender_types':['翼系','水系'],'attack_element':'电系'}).result,'type_row':svc._answer_type_row(rs,{'type':'翼系|水系'}).result,'weakness_summary':summary,'engine_all_neutral_summary':neutral,'type_chart':svc._answer_type_chart(rs).result},ensure_ascii=False,indent=2))

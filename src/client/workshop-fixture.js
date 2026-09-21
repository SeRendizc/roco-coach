// RC-305 开发夹具的接线（三行），**没有任何评价逻辑**。
//
// 它只做一件事：把 `src/client/team-workshop.js` 的同一个模块挂到 `#team-workshop` 上，
// 让开发者不开整张训练场页也能单独调这个模块。产品页是 `src/client/roco.html`，
// 那边由 `roco.js` 的 `mountWorkshop()` 挂同一个模块——两条路径挂的是**同一份代码**。
import {mountTeamWorkshop} from './team-workshop.js';

const workshop = mountTeamWorkshop(document.getElementById('team-workshop'));
window.teamWorkshopFixture = workshop;

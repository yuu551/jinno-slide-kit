// 発表モードの入口（/present.js）。/present と /presenter で同じバンドルを使い、body の data-view で分ける。
import { loadDeck } from './present-core.mjs';
import { startPresent } from './present.mjs';
import { startPresenter } from './presenter.mjs';
import { startPreview } from './preview.mjs';

const deck = await loadDeck();
if (document.body.dataset.view === 'presenter') await startPresenter(deck);
else if (document.body.dataset.view === 'preview') await startPreview(deck);
else await startPresent(deck);

import { confirmDialog } from './dialog.mjs';
import { settings } from './settings.mjs';
export async function openSettings(onChange=()=>{}) {
  const enabled=settings.getItem('mj-autosave')!=='0';
  const answer=await confirmDialog({title:'設定',message:`自動保存は現在${enabled?'オン':'オフ'}です。本文やメモの変更を自動で保存します。ほかの資料には次に開いたときから反映されます。`,ok:'オンにする',cancel:'閉じる',extra:{label:'オフにする',value:'off'}});
  if(answer===false)return;
  const value=answer!=='off';settings.setItem('mj-autosave',value?'1':'0');await settings.flush();onChange(value);
}

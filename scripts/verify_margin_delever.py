#!/usr/bin/env python3
"""獨立複核 js/tabs/marginalert_calc.mjs 的關鍵數字（不共用任何 JS 程式碼）。

用法: python3 scripts/verify_margin_delever.py        # 自動呼叫 node 產生 JSON 後比對
重新用 Python 從 data/*.json 實作：單日門檻觸發日/事件、事件後 20 日報酬與再破底、
年度統計、原始 2/3 規則、客觀波段、個案低點與首次觸發、回撤區間比例。全部一致才印 ALL OK、exit 0。
"""
import json, os, statistics as st, subprocess, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = os.path.join(ROOT, 'data') + '/'
tmp = tempfile.NamedTemporaryFile(suffix='.json', delete=False); tmp.close()
subprocess.run(['node', os.path.join(ROOT, 'scripts/backtest_margin_delever.mjs'), '--out', os.devnull, '--json', tmp.name],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=ROOT)
sys.argv = [sys.argv[0], tmp.name]
L=lambda f:json.load(open(R+f+'.json'))['data']
tw=sorted(L('TWII'),key=lambda r:r['date']); mg=sorted(L('taiwan_margin_total'),key=lambda r:r['date'])
rt={r['date']:r['ratio_all'] for r in L('taiwan_margin_ratio_mm')}
rt.update({r['date']:r['ratio'] for r in L('taiwan_margin_ratio')})
res=json.load(open(sys.argv[1]))
twd=[r['date'] for r in tw]; ti={d:i for i,d in enumerate(twd)}
md=[r['date'] for r in mg]; mi={d:i for i,d in enumerate(md)}
# own implementation
LB=120
dd=[]
for i,r in enumerate(tw):
    hi=max(x['close'] for x in tw[max(0,i-LB+1):i+1]); dd.append((1-r['close']/hi)*100)
days=[d for d in twd if d in mi and '2020-01-01'<=d<='2026-10-16']
def m1(d):
    i=mi[d]; return (mg[i]['margin_money']/mg[i-1]['margin_money']-1)*100
def cluster(idx,cd):
    ev=[]
    for i in idx:
        if ev and i-ev[-1][1]<=cd: ev[-1][1]=i; ev[-1][2]+=1
        else: ev.append([i,i,1])
    return ev
ok=True
def chk(name,a,b,tol=1e-6):
    global ok
    good = (a==b) if not isinstance(a,float) else abs(a-b)<tol
    if not good: ok=False
    print(('OK  ' if good else 'FAIL'),name,a,b)
for th in [2,3,4,5]:
    flags=[k for k,d in enumerate(days) if m1(d)<=-th]
    ev=cluster(flags,10)
    j=res['thresholds'][str(th)]
    chk(f'th{th} flagdays',len(flags),j['flagDays']); chk(f'th{th} events',len(ev),len(j['events']))
    # forward 20d from next open, hold h=20 => exit close idx e+19
    rets=[]
    for s,_,_ in ev:
        t=ti[days[s]]; e=t+1; x=e+19
        if x<len(tw): rets.append((tw[x]['close']/tw[e]['open']-1)*100)
    chk(f'th{th} fwd20 n',len(rets),j['forward']['20']['n'])
    chk(f'th{th} fwd20 median',st.median(rets),j['forward']['20']['retMedian'],1e-6)
    chk(f'th{th} fwd20 mean',sum(rets)/len(rets),j['forward']['20']['retMean'],1e-6)
    # rebreak 20
    rb=0;n=0
    for s,_,_ in ev:
        t=ti[days[s]]; e=t+1; x=e+19
        if x<len(tw):
            n+=1; rb+= any(tw[k]['low']<tw[t]['low'] for k in range(e,x+1))
    chk(f'th{th} rebreak20',rb/n*100,j['forward']['20']['breakLowPct'],1e-6)
# annual
for a in res['annual']:
    y=a['year']; yd=[d for d in days if d.startswith(y)]
    for th in [2,3,4,5]:
        flags=[k for k,d in enumerate(yd) if m1(d)<=-th]
        chk(f'{y} th{th}',(len(flags),len(cluster(flags,10))),(a['byTh'][str(th)]['days'],a['byTh'][str(th)]['events']))
# original 2/3 rule
def ratio_drop(d):
    # ratio series own calendar, 120 window
    ds=sorted(rt); i=ds.index(d); hi=max(rt[x] for x in ds[max(0,i-LB+1):i+1]); return hi-rt[d]
flags=[]
for k,d in enumerate(days):
    A=dd[ti[d]]>=15; B=ratio_drop(d)>=30
    i=mi[d]; C=(mg[i]['margin_money']-mg[i-1]['margin_money'])<=-100
    if A+B+C>=2: flags.append(k)
o=res['rules2of3'][0]
chk('orig rule flagdays',len(flags),o['flagDays']); chk('orig rule events',len(cluster(flags,20)),o['events'])
# waves
waves=[];cur=None
for k,d in enumerate(days):
    x=dd[ti[d]]
    if cur is None and x>=10: cur=[k,k]
    if cur is not None:
        if tw[ti[d]]['close']<tw[ti[days[cur[1]]]]['close']: cur[1]=k
        if x<5 or k==len(days)-1: waves.append((days[cur[0]],days[cur[1]],d)); cur=None
chk('waves',[(w[0],w[1],w[2]) for w in waves],[(w['startDate'],w['lowDate'],w['endDate']) for w in res['waves']])
# cases first triggers & low
for c in res['cases']:
    rows=[d for d in days if c['from']<=d<=c['to']]
    low=min(rows,key=lambda d:tw[ti[d]]['close'])
    chk(c['id']+' low',low,c['low']['date'])
    for th in [2,3,4,5]:
        f=next((d for d in rows if m1(d)<=-th),None)
        chk(f"{c['id']} first{th}",f,(c['first'][str(th)] or {}).get('date'))
# dd band share
b=res['bands120'][4]  # 15-18
sel=[d for d in days if 15<=dd[ti[d]]<18]
chk('band15-18 n',len(sel),b['n']); chk('band p3',sum(1 for d in sel if m1(d)<=-3)/len(sel)*100,b['p3'],1e-6)

# 恐懼貪婪 × 單日 -3% 警報（F&G<15）
fg={r['date']:r['value'] for r in L('fear_greed')}
fa=res['fear']
alarm=[d for d in days if m1(d)<=-3 and d in fg]
fear=[d for d in days if d in fg and fg[d]<15]
non=[d for d in days if d in fg and fg[d]>=15]
chk('fear days',len(fear),fa['fearDays']); chk('alarm days w/ fg',len(alarm),fa['alarmDays'])
chk('P(alarm|fear)',sum(1 for d in fear if m1(d)<=-3)/len(fear)*100,fa['pAlarmGivenFear'],1e-6)
chk('P(alarm|non)',sum(1 for d in non if m1(d)<=-3)/len(non)*100,fa['pAlarmGivenNot'],1e-6)
chk('alarm in fear',sum(1 for d in alarm if fg[d]<15),fa['alarmDaysInFear'])
print('ALL OK' if ok else 'SOME FAIL')

os.unlink(tmp.name)
sys.exit(0 if ok else 1)

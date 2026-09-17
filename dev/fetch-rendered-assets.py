"""Fetch pinned CC0 PBR maps for the optional Rendered demo; never used at runtime."""
from pathlib import Path
import concurrent.futures,hashlib,json,urllib.request
root=Path(__file__).resolve().parents[1]/'public/measure/internal/rendered_assets'
root.mkdir(exist_ok=True)
headers={'User-Agent':'FirstMeasure-Rendered-Demo/1.0'}
def get(url):return urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=90).read()
assets={'siding':'weathered_plank_siding','brick':'brick_wall_001','plaster':'grey_plaster','roof':'clean_asphalt','wood':'wood_table_001'}
files=[]
for name,slug in assets.items():
 data=json.loads(get('https://api.polyhaven.com/files/'+slug))
 for kind,source in [('albedo','Diffuse'),('normal','nor_gl'),('arm','arm')]:
  item=data[source]['2k']['jpg'];files.append(dict(item,file=name+'-'+kind+'.jpg',asset=slug,kind=kind))
slug='kloofendal_48d_partly_cloudy'
item=json.loads(get('https://api.polyhaven.com/files/'+slug))['hdri']['2k']['hdr'];files.append(dict(item,file='daylight.hdr',asset=slug,kind='environment'))
def download(item):
 p=root/item['file'];b=p.read_bytes() if p.exists() else get(item['url'])
 assert hashlib.md5(b).hexdigest()==item['md5'],item['file']
 p.write_bytes(b);return {**item,'sha256':hashlib.sha256(b).hexdigest()}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:files=list(pool.map(download,files))
(root/'manifest.json').write_text(json.dumps({'license':'CC0-1.0','source':'https://polyhaven.com/license','resolution':'2k','files':files},indent=2)+'\n')
(root/'README.md').write_text('# Rendered mode assets\n\nReal 2K PBR textures and HDR environment by Poly Haven, CC0.\nDownloaded with the public API; Powered by Poly Haven: https://polyhaven.com\nSee manifest.json for source URLs and integrity hashes. Assets are served locally; no project data is sent to Poly Haven.\n')
print('Verified',len(files),'assets;',sum(x['size'] for x in files),'bytes')

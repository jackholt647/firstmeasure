package ai.firstmeasure.mobile;

import android.webkit.*;
import android.view.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.rule.GrantPermissionRule;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.*;
import org.junit.runner.RunWith;
import java.util.concurrent.*;
import java.io.*;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class NativeCameraBridgeTest {
 @Rule public GrantPermissionRule permission=GrantPermissionRule.grant(android.Manifest.permission.CAMERA);
 private WebView find(View v){if(v instanceof WebView)return (WebView)v;if(v instanceof ViewGroup){for(int i=0;i<((ViewGroup)v).getChildCount();i++){WebView w=find(((ViewGroup)v).getChildAt(i));if(w!=null)return w;}}return null;}
 @Test public void nativeZoomBridgePreservesWebControlsAndRejectsStaleSession() throws Exception {
  try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
   CountDownLatch loaded=new CountDownLatch(1);
   String html="<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body style='margin:0;background:transparent'><div style='height:60px;background:white'>FirstMate camera integration test</div><div style='height:320px;background:transparent'></div><button style='background:red;color:white;width:100%;height:50px'>FirstMate controls above native preview</button><script>const calls=new Map();let n=0;FirstMeasureNative.onmessage=e=>{const r=JSON.parse(e.data),p=calls.get(r.id);if(p){calls.delete(r.id);r.error?p.reject(r.error):p.resolve(r.result);}};window.call=(method,payload={})=>new Promise((resolve,reject)=>{const id=String(++n);calls.set(id,{resolve,reject});FirstMeasureNative.postMessage(JSON.stringify({version:1,id,method,payload}));});window.run=async()=>{try{const session='11111111-1111-1111-1111-111111111111';const state=await call('cameraOpen',{session,mode:'photo',facing:'environment',bounds:{x:0,y:60,width:innerWidth,height:320,viewportWidth:innerWidth}});if(!(state.max>=state.min))throw Error('bad range');await call('cameraZoom',{session,value:state.min});let rejected=false;try{await call('cameraClose',{session:'22222222-2222-2222-2222-222222222222'});}catch(e){rejected=e.code==='camera_closed';}if(!rejected)throw Error('stale session accepted');const photo=await call('cameraPhoto',{session});const chunk=await call('cameraRead',{token:photo.token,offset:0});if(!chunk.data)throw Error('empty photo');await call('cameraRelease',{token:photo.token});document.title='passed';}catch(e){document.title='failed:'+JSON.stringify(e);}};</script></body></html>";
   scenario.onActivity(a->{WebView web=find(a.getWindow().getDecorView());web.stopLoading();web.setWebViewClient(new WebViewClient(){
    @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){return new WebResourceResponse("text/html","UTF-8",new ByteArrayInputStream(html.getBytes(java.nio.charset.StandardCharsets.UTF_8)));}
    @Override public void onPageFinished(WebView v,String url){if(url.endsWith("/native-camera-fixture")){loaded.countDown();v.evaluateJavascript("run()",null);}}
   });web.loadUrl(BuildConfig.PORTAL_ORIGIN+"/native-camera-fixture");});
   assertTrue(loaded.await(20,TimeUnit.SECONDS));String[] title={""};long deadline=System.currentTimeMillis()+30000;
   while(System.currentTimeMillis()<deadline){CountDownLatch read=new CountDownLatch(1);scenario.onActivity(a->find(a.getWindow().getDecorView()).evaluateJavascript("document.title",v->{title[0]=v;read.countDown();}));assertTrue(read.await(3,TimeUnit.SECONDS));if(title[0].contains("passed")||title[0].contains("failed"))break;Thread.sleep(100);}
   assertEquals("\"passed\"",title[0]);
   android.graphics.Bitmap screen=InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
   File evidence=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null),"native-camera-preview.png");
   try(FileOutputStream file=new FileOutputStream(evidence)){screen.compress(android.graphics.Bitmap.CompressFormat.PNG,100,file);}
  }
 }
}

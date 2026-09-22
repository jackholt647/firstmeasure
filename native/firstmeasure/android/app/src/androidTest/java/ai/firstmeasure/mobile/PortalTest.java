package ai.firstmeasure.mobile;
import android.webkit.WebView;
import android.content.pm.ActivityInfo;
import android.view.ViewGroup;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.*;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class PortalTest {
    @Test public void cancelledFileSelectionCompletesWithoutUploading() throws Exception {
        androidx.test.espresso.intent.Intents.init();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            androidx.test.espresso.intent.Intents.intending(androidx.test.espresso.intent.matcher.IntentMatchers.hasAction(android.content.Intent.ACTION_CHOOSER)).respondWith(new android.app.Instrumentation.ActivityResult(android.app.Activity.RESULT_CANCELED,null));
            CountDownLatch finished=new CountDownLatch(1);android.net.Uri[][] result={new android.net.Uri[0]};
            scenario.onActivity(activity->{WebView web=find(activity.getWindow().getDecorView());web.loadDataWithBaseURL(BuildConfig.PORTAL_ORIGIN+"/portal/","<html></html>","text/html","UTF-8",null);
                web.getWebChromeClient().onShowFileChooser(web,uris->{result[0]=uris;finished.countDown();},new android.webkit.WebChromeClient.FileChooserParams(){
                    public int getMode(){return MODE_OPEN_MULTIPLE;}public String[] getAcceptTypes(){return new String[]{"image/*"};}public boolean isCaptureEnabled(){return false;}public CharSequence getTitle(){return "Photos";}public String getFilenameHint(){return null;}public android.content.Intent createIntent(){return new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);}
                });
            });
            assertTrue(finished.await(15,TimeUnit.SECONDS));assertNull(result[0]);
        } finally { androidx.test.espresso.intent.Intents.release(); }
    }
    private WebView find(android.view.View view){if(view instanceof WebView)return (WebView)view;if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int i=0;i<group.getChildCount();i++){WebView found=find(group.getChildAt(i));if(found!=null)return found;}}return null;}
    @Test public void secureWebViewSurvivesRecreation() {
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity->{WebView web=find(activity.getWindow().getDecorView());assertNotNull(web);assertFalse(web.getSettings().getAllowFileAccess());assertEquals(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW,web.getSettings().getMixedContentMode());});
            scenario.recreate();
            scenario.onActivity(activity->{assertNotNull(find(activity.getWindow().getDecorView()));activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);});
        }
    }
    @Test public void untrustedPageHasNoNativeBridge() throws Exception {
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            CountDownLatch loaded=new CountDownLatch(1);String[] result={null};
            scenario.onActivity(activity->{WebView web=find(activity.getWindow().getDecorView());web.stopLoading();web.setWebViewClient(new android.webkit.WebViewClient(){@Override public android.webkit.WebResourceResponse shouldInterceptRequest(WebView v,android.webkit.WebResourceRequest r){return new android.webkit.WebResourceResponse("text/html","UTF-8",new java.io.ByteArrayInputStream("<html><body>Security fixture</body></html>".getBytes()));}@Override public void onPageFinished(WebView v,String url){if(!url.endsWith("/mobile-test-fixture"))return;v.evaluateJavascript("typeof window.FirstMeasureNative",value->{result[0]=value;loaded.countDown();});}});web.loadUrl("https://untrusted.example/mobile-test-fixture");});
            assertTrue(loaded.await(20,TimeUnit.SECONDS));assertEquals("\"undefined\"",result[0]);
        }
    }
    @Test public void trustedMainFrameCanReadVersionedInfo() throws Exception {
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            CountDownLatch loaded=new CountDownLatch(1);String[] result={null};
            scenario.onActivity(activity->{WebView web=find(activity.getWindow().getDecorView());web.setWebViewClient(new android.webkit.WebViewClient(){@Override public android.webkit.WebResourceResponse shouldInterceptRequest(WebView v,android.webkit.WebResourceRequest r){return new android.webkit.WebResourceResponse("text/html","UTF-8",new java.io.ByteArrayInputStream("<html><body>Bridge fixture</body></html>".getBytes()));}@Override public void onPageFinished(WebView v,String url){if(!url.endsWith("/mobile-test-fixture"))return;v.evaluateJavascript("new Promise(resolve=>{FirstMeasureNative.onmessage=e=>{document.title=JSON.parse(e.data).result.platform;};FirstMeasureNative.postMessage(JSON.stringify({version:1,id:'test',method:'info',payload:{}}));});",value->loaded.countDown());}});web.loadUrl(BuildConfig.PORTAL_ORIGIN+"/mobile-test-fixture");});
            assertTrue(loaded.await(20,TimeUnit.SECONDS));
            // Wait for the asynchronous WebMessage reply without relying on network access.
            long until=System.currentTimeMillis()+10000;
            while(System.currentTimeMillis()<until){CountDownLatch read=new CountDownLatch(1);scenario.onActivity(a->find(a.getWindow().getDecorView()).evaluateJavascript("document.title",v->{result[0]=v;read.countDown();}));assertTrue(read.await(2,TimeUnit.SECONDS));if("\"android\"".equals(result[0]))break;Thread.sleep(100);}
            assertEquals("\"android\"",result[0]);
        }
    }
}

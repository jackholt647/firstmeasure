package ai.firstmeasure.mobile;

import android.widget.FrameLayout;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.rule.GrantPermissionRule;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import java.util.concurrent.*;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class NativeCameraTest {
    @Rule public GrantPermissionRule permission=GrantPermissionRule.grant(android.Manifest.permission.CAMERA);
    @Test public void nativePreviewZoomPhotoAndVideoStayInsideHost() throws Exception {
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            NativeCameraController[] camera={null};
            scenario.onActivity(a->{FrameLayout host=new FrameLayout(a);a.setContentView(host);camera[0]=new NativeCameraController(a,host);});
            JSONObject photoState=open(scenario,camera[0],"photo");
            assertTrue(photoState.getDouble("min")>0);assertTrue(photoState.getDouble("max")>=photoState.getDouble("min"));
            CountDownLatch zoomed=new CountDownLatch(1);String[] failure={null};
            scenario.onActivity(a->camera[0].zoom(photoState.optDouble("max"),(value,error)->{failure[0]=error;zoomed.countDown();}));
            assertTrue(zoomed.await(15,TimeUnit.SECONDS));assertNull(failure[0]);
            CountDownLatch captured=new CountDownLatch(1);JSONObject[] photo={null};
            scenario.onActivity(a->camera[0].photo((value,error)->{failure[0]=error;photo[0]=(JSONObject)value;captured.countDown();}));
            assertTrue(captured.await(20,TimeUnit.SECONDS));assertNull(failure[0]);assertEquals("image/jpeg",photo[0].getString("mime"));
            String token=photo[0].getString("token");
            byte[] bytes=android.util.Base64.decode(camera[0].read(token,0).getString("data"),android.util.Base64.DEFAULT);
            assertEquals(255,bytes[0]&255);assertEquals(216,bytes[1]&255);camera[0].release(token);
            try{camera[0].read(token,0);fail("Released capture remained accessible");}catch(java.io.IOException expected){}
            open(scenario,camera[0],"video");
            CountDownLatch recorded=new CountDownLatch(1);JSONObject[] video={null};
            scenario.onActivity(a->camera[0].record((value,error)->{failure[0]=error;video[0]=(JSONObject)value;recorded.countDown();}));
            Thread.sleep(3500);
            scenario.onActivity(a->camera[0].stopRecording());
            assertTrue(recorded.await(20,TimeUnit.SECONDS));assertNull(failure[0]);assertEquals("video/mp4",video[0].getString("mime"));assertTrue(video[0].getLong("duration")>=1000);
            scenario.onActivity(a->camera[0].destroy());
        }
    }
    private JSONObject open(ActivityScenario<MainActivity> scenario,NativeCameraController camera,String mode) throws Exception {
        CountDownLatch opened=new CountDownLatch(1);JSONObject[] result={null};String[] error={null};
        scenario.onActivity(a->{try{camera.bounds(new JSONObject().put("viewportWidth",360).put("x",0).put("y",0).put("width",320).put("height",400),a.getResources().getDisplayMetrics().widthPixels);camera.open(new JSONObject().put("mode",mode).put("facing","environment"),(value,failure)->{result[0]=(JSONObject)value;error[0]=failure;opened.countDown();});}catch(Exception e){throw new RuntimeException(e);}});
        assertTrue(opened.await(30,TimeUnit.SECONDS));assertNull(error[0]);return result[0];
    }
}

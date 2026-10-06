package ai.firstmeasure.mobile;

import android.graphics.Color;
import android.graphics.Outline;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.widget.FrameLayout;
import androidx.activity.ComponentActivity;
import androidx.camera.core.*;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.video.*;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import org.json.JSONObject;
import java.io.*;
import java.util.*;
import java.util.concurrent.Executor;

/** In-app native preview/capture. Zoom stays on the logical camera so Android
 * selects physical lenses without replacing the recording stream. */
final class NativeCameraController {
    interface Reply { void complete(Object result, String error); }
    private final ComponentActivity activity;
    private final PreviewView preview;
    private final Executor main;
    private ProcessCameraProvider provider;
    private Camera camera;
    private ImageCapture photos;
    private VideoCapture<Recorder> videos;
    private Recording recording;
    private int generation;
    private final Map<String,File> files = new HashMap<>();

    NativeCameraController(ComponentActivity activity, FrameLayout host) {
        this.activity=activity;main=ContextCompat.getMainExecutor(activity);
        preview=new PreviewView(activity);
        preview.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        preview.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        preview.setBackgroundColor(Color.BLACK);preview.setVisibility(View.GONE);
        preview.setOutlineProvider(new ViewOutlineProvider(){public void getOutline(View v,Outline o){o.setRoundRect(0,0,v.getWidth(),v.getHeight(),22*activity.getResources().getDisplayMetrics().density);}});
        preview.setClipToOutline(true);host.addView(preview,new FrameLayout.LayoutParams(1,1));
    }
    void bounds(JSONObject p, int webWidth) throws Exception {
        double viewport=p.getDouble("viewportWidth"),scale=webWidth/viewport;
        if(!Double.isFinite(scale)||scale<=0||scale>10)throw new Exception("Invalid viewport");
        int x=(int)Math.round(p.getDouble("x")*scale),y=(int)Math.round(p.getDouble("y")*scale);
        int w=(int)Math.round(p.getDouble("width")*scale),h=(int)Math.round(p.getDouble("height")*scale);
        if(x<0||y<0||w<1||h<1||x+w>webWidth+2||h>activity.getResources().getDisplayMetrics().heightPixels*2)throw new Exception("Invalid camera bounds");
        FrameLayout.LayoutParams layout=new FrameLayout.LayoutParams(w,h);layout.leftMargin=x;layout.topMargin=y;preview.setLayoutParams(layout);
    }
    void open(JSONObject p, Reply reply) {
        close();final int epoch=generation;
        var future=ProcessCameraProvider.getInstance(activity);
        future.addListener(()->{
            if(epoch!=generation){reply.complete(null,"camera_closed");return;}
            try {
                provider=future.get();
                int facing="user".equals(p.optString("facing"))?CameraSelector.LENS_FACING_FRONT:CameraSelector.LENS_FACING_BACK;
                CameraSelector selector=new CameraSelector.Builder().requireLensFacing(facing).build();
                // Prefer the logical camera advertising the broadest zoom range.
                // No model names or presumed focal-length multipliers are used.
                List<CameraInfo> available=selector.filter(provider.getAvailableCameraInfos());
                if(available.isEmpty())throw new Exception("Camera unavailable");
                CameraInfo best=available.get(0);double score=range(best);
                for(CameraInfo info:available){double r=range(info);if(r>score){score=r;best=info;}}
                final CameraInfo chosen=best;
                selector=new CameraSelector.Builder().addCameraFilter(infos->{List<CameraInfo> selected=new ArrayList<>();for(CameraInfo info:infos)if(info==chosen)selected.add(info);return selected;}).build();
                Preview useCase=new Preview.Builder().build();useCase.setSurfaceProvider(preview.getSurfaceProvider());
                if("video".equals(p.optString("mode"))){
                    Recorder recorder=new Recorder.Builder().setQualitySelector(QualitySelector.fromOrderedList(Arrays.asList(Quality.FHD,Quality.HD,Quality.SD),FallbackStrategy.lowerQualityOrHigherThan(Quality.SD))).build();
                    videos=VideoCapture.withOutput(recorder);camera=provider.bindToLifecycle(activity,selector,useCase,videos);
                }else{
                    photos=new ImageCapture.Builder().setTargetResolution(new android.util.Size(2560,1920)).setJpegQuality(85).setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build();
                    camera=provider.bindToLifecycle(activity,selector,useCase,photos);
                }
                preview.setVisibility(View.VISIBLE);
                boolean flip=provider.hasCamera(new CameraSelector.Builder().requireLensFacing(facing==CameraSelector.LENS_FACING_BACK?CameraSelector.LENS_FACING_FRONT:CameraSelector.LENS_FACING_BACK).build());
                JSONObject result=state();result.put("canSwitch",flip);reply.complete(result,null);
            }catch(Exception e){close();reply.complete(null,"camera_unavailable");}
        },main);
    }
    private static double range(CameraInfo info){ZoomState z=info.getZoomState().getValue();return z==null?0:z.getMaxZoomRatio()/z.getMinZoomRatio();}
    private JSONObject state() throws Exception {
        ZoomState z=camera.getCameraInfo().getZoomState().getValue();
        if(z==null)throw new Exception("Zoom unavailable");
        return new JSONObject().put("min",z.getMinZoomRatio()).put("max",z.getMaxZoomRatio()).put("value",z.getZoomRatio());
    }
    void zoom(double value, Reply reply){
        if(camera==null||!Double.isFinite(value)){reply.complete(null,"camera_closed");return;}
        ZoomState z=camera.getCameraInfo().getZoomState().getValue();
        if(z==null){reply.complete(null,"zoom_unavailable");return;}
        var pending=camera.getCameraControl().setZoomRatio((float)Math.max(z.getMinZoomRatio(),Math.min(z.getMaxZoomRatio(),value)));
        pending.addListener(()->{try{pending.get();reply.complete(state(),null);}catch(Exception e){reply.complete(null,"zoom_failed");}},main);
    }
    private File output(String extension) throws IOException {File dir=new File(activity.getCacheDir(),"native-camera");dir.mkdirs();return File.createTempFile("capture-",extension,dir);}
    private JSONObject saved(File file,String mime,long duration) throws Exception {
        if(file.length()>150L*1024*1024){file.delete();throw new IOException("File too large");}
        String token=UUID.randomUUID().toString();files.put(token,file);
        return new JSONObject().put("token",token).put("name",file.getName()).put("mime",mime).put("size",file.length()).put("duration",duration);
    }
    void photo(Reply reply){
        if(photos==null){reply.complete(null,"camera_closed");return;}
        try{File file=output(".jpg");photos.takePicture(new ImageCapture.OutputFileOptions.Builder(file).build(),main,new ImageCapture.OnImageSavedCallback(){
            public void onImageSaved(ImageCapture.OutputFileResults result){try{reply.complete(saved(file,"image/jpeg",0),null);}catch(Exception e){file.delete();reply.complete(null,"capture_failed");}}
            public void onError(ImageCaptureException e){file.delete();reply.complete(null,"capture_failed");}
        });}catch(Exception e){reply.complete(null,"capture_failed");}
    }
    void record(Reply reply){
        if(videos==null||recording!=null){reply.complete(null,"camera_busy");return;}
        try {
            File file=output(".mp4");
            recording=videos.getOutput().prepareRecording(activity,new FileOutputOptions.Builder(file).setFileSizeLimit(120L*1024*1024).setDurationLimitMillis(150000).build()).start(main,event->{
                if(event instanceof VideoRecordEvent.Finalize){
                    recording=null;VideoRecordEvent.Finalize end=(VideoRecordEvent.Finalize)event;
                    long duration=end.getRecordingStats().getRecordedDurationNanos()/1000000;
                    try{if((end.hasError()&&end.getError()!=VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED&&end.getError()!=VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED)||duration<1000)throw new IOException("Recording failed or too short");reply.complete(saved(file,"video/mp4",duration),null);}
                    catch(Exception e){file.delete();reply.complete(null,"recording_failed");}
                }
            });
        }catch(Exception e){recording=null;reply.complete(null,"recording_failed");}
    }
    void stopRecording(){if(recording!=null)recording.stop();}
    void pause(boolean paused){if(recording!=null){if(paused)recording.pause();else recording.resume();}}
    JSONObject read(String token,int offset) throws Exception {
        File f=files.get(token);if(f==null||offset<0||offset>f.length())throw new IOException("Unknown capture");
        byte[] bytes=new byte[(int)Math.min(256*1024,f.length()-offset)];
        try(RandomAccessFile input=new RandomAccessFile(f,"r")){input.seek(offset);input.readFully(bytes);}
        return new JSONObject().put("data",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP));
    }
    void release(String token){File f=files.remove(token);if(f!=null)f.delete();}
    void close(){generation++;stopRecording();if(provider!=null)provider.unbindAll();camera=null;photos=null;videos=null;preview.setVisibility(View.GONE);}
    void destroy(){close();for(File f:files.values())f.delete();files.clear();}
}

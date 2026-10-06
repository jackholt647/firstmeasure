package ai.firstmeasure.mobile;

import android.graphics.Color;
import android.hardware.camera2.CameraCharacteristics;
import androidx.camera.camera2.interop.Camera2CameraInfo;
import androidx.camera.camera2.interop.ExperimentalCamera2Interop;
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

/** Native capture with one normalized zoom scale across exposed rear cameras. */
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
    private Preview previewUseCase;
    private final List<CameraInfo> choices = new ArrayList<>();
    private final List<CameraZoomRange> ranges = new ArrayList<>();
    private int selected;
    private boolean videoMode;

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
                videoMode="video".equals(p.optString("mode"));
                choices.clear();ranges.clear();
                List<CameraInfo> available=selector.filter(provider.getAvailableCameraInfos());
                CameraInfo standard=available.isEmpty()?null:available.get(0);
                for(CameraInfo info:available){
                    if(videoMode&&Recorder.getVideoCapabilities(info).getSupportedQualities(DynamicRange.SDR).isEmpty())continue;
                    ZoomState z=info.getZoomState().getValue();
                    if(z==null)continue;
                    choices.add(info);ranges.add(new CameraZoomRange(intrinsic(info,standard),z.getMinZoomRatio(),z.getMaxZoomRatio()));
                }
                if(choices.isEmpty())throw new Exception("Camera unavailable");
                previewUseCase=new Preview.Builder().build();previewUseCase.setSurfaceProvider(preview.getSurfaceProvider());
                if(videoMode){
                    Recorder recorder=new Recorder.Builder().setQualitySelector(QualitySelector.fromOrderedList(Arrays.asList(Quality.FHD,Quality.HD,Quality.SD),FallbackStrategy.lowerQualityOrHigherThan(Quality.SD))).build();
                    videos=VideoCapture.withOutput(recorder);
                }else photos=new ImageCapture.Builder().setTargetResolution(new android.util.Size(2560,1920)).setJpegQuality(85).setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build();
                bind(CameraZoomRange.select(ranges,1));
                preview.setVisibility(View.VISIBLE);
                boolean flip=provider.hasCamera(new CameraSelector.Builder().requireLensFacing(facing==CameraSelector.LENS_FACING_BACK?CameraSelector.LENS_FACING_FRONT:CameraSelector.LENS_FACING_BACK).build());
                JSONObject result=state();result.put("canSwitch",flip);reply.complete(result,null);
            }catch(Exception e){close();reply.complete(null,"camera_unavailable");}
        },main);
    }
    @androidx.annotation.OptIn(markerClass = ExperimentalCamera2Interop.class)
    private static double focalScale(CameraInfo info){
        Camera2CameraInfo details=Camera2CameraInfo.from(info);
        float[] lengths=details.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
        android.util.SizeF sensor=details.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
        android.util.Size pixels=details.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE);
        android.graphics.Rect active=details.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
        if(lengths==null||lengths.length==0||sensor==null||sensor.getWidth()<=0)return Double.NaN;
        double width=sensor.getWidth();
        if(pixels!=null&&active!=null&&pixels.getWidth()>0)width*=((double)active.width())/pixels.getWidth();
        return lengths[0]/width;
    }
    private static double intrinsic(CameraInfo info,CameraInfo standard){
        if(info==standard)return 1;
        try{double ratio=focalScale(info)/focalScale(standard);if(Double.isFinite(ratio)&&ratio>0)return ratio;}catch(Exception ignored){}
        return info.getIntrinsicZoomRatio();
    }
    private void bind(int index){
        provider.unbindAll();camera=null;
        CameraSelector selector=choices.get(index).getCameraSelector();
        camera=videoMode?provider.bindToLifecycle(activity,selector,previewUseCase,videos):provider.bindToLifecycle(activity,selector,previewUseCase,photos);
        selected=index;
    }
    private JSONObject state() throws Exception {
        ZoomState z=camera.getCameraInfo().getZoomState().getValue();
        if(z==null)throw new Exception("Zoom unavailable");
        double min=ranges.stream().mapToDouble(r->r.min).min().orElse(1),max=ranges.stream().mapToDouble(r->r.max).max().orElse(1);
        return new JSONObject().put("min",min).put("max",max).put("value",z.getZoomRatio()*ranges.get(selected).intrinsic);
    }
    void zoom(double value, Reply reply){
        if(camera==null||!Double.isFinite(value)||value<=0){reply.complete(null,"camera_closed");return;}
        int previous=selected,next=CameraZoomRange.select(ranges,value),epoch=generation;
        try{
            // A persistent recording keeps the same output while VideoCapture is
            // rebound. Front/rear switching remains a separate, idle-only control.
            if(next!=selected)bind(next);
            CameraZoomRange range=ranges.get(selected);
            var pending=camera.getCameraControl().setZoomRatio((float)range.local(value));
            pending.addListener(()->{try{pending.get();if(epoch!=generation)throw new Exception("closed");reply.complete(state(),null);}catch(Exception e){reply.complete(null,"zoom_failed");}},main);
        }catch(Exception e){
            try{if(selected!=previous||camera==null)bind(previous);}catch(Exception ignored){}
            reply.complete(null,"zoom_failed");
        }
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
    @androidx.annotation.OptIn(markerClass = ExperimentalPersistentRecording.class)
    void record(Reply reply){
        if(videos==null||recording!=null){reply.complete(null,"camera_busy");return;}
        try {
            File file=output(".mp4");
            recording=videos.getOutput().prepareRecording(activity,new FileOutputOptions.Builder(file).setFileSizeLimit(120L*1024*1024).setDurationLimitMillis(150000).build()).asPersistentRecording().start(main,event->{
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

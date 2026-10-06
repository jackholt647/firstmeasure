package ai.firstmeasure.mobile;

import android.graphics.Color;
import android.hardware.camera2.*;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.camera.camera2.interop.Camera2Interop;
import androidx.camera.camera2.interop.Camera2CameraInfo;
import androidx.camera.camera2.interop.ExperimentalCamera2Interop;
import android.graphics.Outline;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.widget.FrameLayout;
import androidx.activity.ComponentActivity;
import androidx.camera.core.*;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.video.*;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import org.json.JSONObject;
import java.io.*;
import java.util.*;
import java.util.concurrent.Executor;
import java.util.concurrent.CompletableFuture;
import org.json.JSONArray;

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
    private final List<CameraInventory.Route> routes = new ArrayList<>();
    private final Set<Integer> unavailable = new HashSet<>();
    private final Map<String,String> discoveryFailures = new LinkedHashMap<>();
    private final Map<String,JSONObject> observations = new LinkedHashMap<>();
    private final Handler handler=new Handler(Looper.getMainLooper());
    private CompletableFuture<Void> firstFrame;
    private int bindingEpoch;
    private boolean canSwitch;

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
    @androidx.annotation.OptIn(markerClass = ExperimentalCamera2Interop.class)
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
                choices.clear();ranges.clear();routes.clear();unavailable.clear();discoveryFailures.clear();observations.clear();
                List<CameraInfo> available=selector.filter(provider.getAvailableCameraInfos());
                if(available.isEmpty())throw new Exception("Camera unavailable");
                Map<String,CameraInfo> topLevel=new LinkedHashMap<>();
                for(CameraInfo info:available)topLevel.put(Camera2CameraInfo.from(info).getCameraId(),info);
                String standard=Camera2CameraInfo.from(available.get(0)).getCameraId();
                CameraInventory inventory=CameraInventory.discover(new AndroidCameraInventory(activity.getSystemService(CameraManager.class)),facing,standard);
                discoveryFailures.putAll(inventory.failures);
                for(CameraInventory.Route route:inventory.routes){
                    CameraInfo parent=topLevel.get(route.logicalId);
                    if(parent==null){discoveryFailures.put(route.key(),"parent_not_available_to_camerax");continue;}
                    // A physical child often has no standalone CamcorderProfile.
                    // It records through its logical parent, so never filter it by that.
                    if(videoMode&&Recorder.getVideoCapabilities(parent).getSupportedQualities(DynamicRange.SDR).isEmpty()){discoveryFailures.put(route.key(),"parent_has_no_video_quality");continue;}
                    ZoomState z=parent.getZoomState().getValue();
                    if(z==null)continue;
                    double min=route.physicalId==null?z.getMinZoomRatio():1;
                    double max=Math.min(route.range.localMax,z.getMaxZoomRatio());
                    choices.add(parent);routes.add(route);ranges.add(new CameraZoomRange(route.range.intrinsic,min,max));
                }
                if(choices.isEmpty())throw new Exception("Camera unavailable");
                if(videoMode){
                    Recorder recorder=new Recorder.Builder().setQualitySelector(videoQuality()).build();
                    videos=VideoCapture.withOutput(recorder);
                }else photos=new ImageCapture.Builder().setTargetResolution(new android.util.Size(2560,1920)).setJpegQuality(85).setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build();
                preview.setVisibility(View.VISIBLE);
                canSwitch=provider.hasCamera(new CameraSelector.Builder().requireLensFacing(facing==CameraSelector.LENS_FACING_BACK?CameraSelector.LENS_FACING_FRONT:CameraSelector.LENS_FACING_BACK).build());
                CompletableFuture<Void> ready=bind(CameraZoomRange.select(ranges,1));
                ready.whenCompleteAsync((value,error)->{
                    if(epoch!=generation){reply.complete(null,"camera_closed");return;}
                    try{if(error!=null)throw new Exception(error);calibrateReference(standard);reply.complete(state(),null);}catch(Exception e){close();reply.complete(null,"camera_unavailable");}
                },main);
            }catch(Exception e){close();reply.complete(null,"camera_unavailable");}
        },main);
    }
    @androidx.annotation.OptIn(markerClass = ExperimentalCamera2Interop.class)
    private CompletableFuture<Void> bind(int index){
        final int epoch=++bindingEpoch;
        if(firstFrame!=null&&!firstFrame.isDone())firstFrame.completeExceptionally(new Exception("Camera replaced"));
        firstFrame=new CompletableFuture<>();final CompletableFuture<Void> ready=firstFrame;
        provider.unbindAll();camera=null;
        CameraInventory.Route route=routes.get(index);
        Preview.Builder builder=new Preview.Builder();
        if(route.physicalId!=null){
            List<android.util.Size> sizes=physicalSizes(route.physicalId,false);
            if(!sizes.isEmpty())builder.setResolutionSelector(new ResolutionSelector.Builder().setResolutionFilter((supported,rotation)->{List<android.util.Size> common=new ArrayList<>(supported);common.retainAll(sizes);return common;}).build());
        }
        Camera2Interop.Extender<Preview> interop=new Camera2Interop.Extender<>(builder);
        // CameraSelector alone does not configure the ordinary single-camera
        // bind path in CameraX 1.5. Set the session's physical output explicitly.
        // CameraX applies this ID to all outputs bound in this session (video/JPEG
        // included); rebuilding Preview clears it when returning to logical mode.
        if(route.physicalId!=null)interop.setPhysicalCameraId(route.physicalId);
        interop.setSessionCaptureCallback(new CameraCaptureSession.CaptureCallback(){
            @Override public void onCaptureCompleted(CameraCaptureSession session,CaptureRequest request,TotalCaptureResult result){
                main.execute(()->{
                    if(epoch!=bindingEpoch)return;
                    try{
                        JSONObject observed=new JSONObject().put("streaming",true).put("logicalId",route.logicalId).put("physicalId",route.physicalId==null?JSONObject.NULL:route.physicalId);
                        CaptureResult actual=result;
                        if(Build.VERSION.SDK_INT>=28){
                            observed.put("activePhysicalId",result.get(CaptureResult.LOGICAL_MULTI_CAMERA_ACTIVE_PHYSICAL_ID));
                            observed.put("physicalResults",new JSONArray(result.getPhysicalCameraResults().keySet()));
                            if(route.physicalId!=null&&result.getPhysicalCameraResults().containsKey(route.physicalId))actual=result.getPhysicalCameraResults().get(route.physicalId);
                        }
                        observed.put("focalLength",actual.get(CaptureResult.LENS_FOCAL_LENGTH));
                        android.graphics.Rect crop=actual.get(CaptureResult.SCALER_CROP_REGION);
                        if(crop!=null)observed.put("crop",new JSONArray(new int[]{crop.left,crop.top,crop.right,crop.bottom}));
                        observations.put(route.key(),observed);
                        ready.complete(null);
                    }catch(Exception e){ready.completeExceptionally(e);}
                });
            }
        });
        previewUseCase=builder.build();previewUseCase.setSurfaceProvider(preview.getSurfaceProvider());
        if(!videoMode){
            ImageCapture.Builder image=new ImageCapture.Builder().setJpegQuality(85).setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY);
            List<android.util.Size> sizes=route.physicalId==null?List.of():physicalSizes(route.physicalId,true);
            if(!sizes.isEmpty())image.setResolutionSelector(new ResolutionSelector.Builder().setResolutionFilter((supported,rotation)->{List<android.util.Size> common=new ArrayList<>(supported);common.retainAll(sizes);return common;}).build());
            else image.setTargetResolution(new android.util.Size(2560,1920));
            photos=image.build();
        }
        CameraSelector selector=choices.get(index).getCameraSelector();
        camera=videoMode?provider.bindToLifecycle(activity,selector,previewUseCase,videos):provider.bindToLifecycle(activity,selector,previewUseCase,photos);
        selected=index;
        handler.postDelayed(()->{if(!ready.isDone())ready.completeExceptionally(new Exception("No camera frames"));},8000);
        return ready;
    }
    private void calibrateReference(String standard){
        // Logical characteristics may list several focal lengths. When the HAL
        // tells us which physical camera produced 1x, use that sensor as the
        // reference instead of assuming the first advertised focal length is 1x.
        try{
            CameraInventory.Route current=routes.get(selected);
            if(current.physicalId!=null||!current.logicalId.equals(standard))return;
            JSONObject observed=observations.get(current.key());
            String active=observed==null?"":observed.optString("activePhysicalId","");
            if(active.isEmpty()||active.equals(standard))return;
            AndroidCameraInventory source=new AndroidCameraInventory(activity.getSystemService(CameraManager.class));
            double factor=source.read(active).focalScale/source.read(standard).focalScale;
            if(!Double.isFinite(factor)||factor<=0)return;
            for(int i=0;i<ranges.size();i++){
                CameraZoomRange z=ranges.get(i);CameraInventory.Route r=routes.get(i);
                ranges.set(i,new CameraZoomRange(r.physicalId==null&&r.logicalId.equals(standard)?1:z.intrinsic/factor,z.localMin,z.localMax));
            }
        }catch(Exception ignored){/* Retain advertised sensor geometry when active metadata is absent. */}
    }
    private List<android.util.Size> physicalSizes(String id,boolean jpeg){
        try{
            var map=activity.getSystemService(CameraManager.class).getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if(map==null)return List.of();
            android.util.Size[] sizes=jpeg?map.getOutputSizes(android.graphics.ImageFormat.JPEG):map.getOutputSizes(android.graphics.SurfaceTexture.class);
            return sizes==null?List.of():Arrays.asList(sizes);
        }catch(Exception e){return List.of();}
    }
    private QualitySelector videoQuality(){
        // A physical child may not have a CamcorderProfile. Use its advertised
        // stream sizes and the parent's encoder profile, choosing a common size
        // so one persistent recording can cross lens boundaries.
        List<Quality> candidates=Arrays.asList(Quality.FHD,Quality.HD,Quality.SD);
        for(Quality quality:candidates){
            boolean supported=true;
            for(int i=0;i<routes.size();i++){
                android.util.Size size=QualitySelector.getResolution(choices.get(i),quality);
                List<android.util.Size> sizes=routes.get(i).physicalId==null?List.of():physicalSizes(routes.get(i).physicalId,false);
                if(size==null||(!sizes.isEmpty()&&!sizes.contains(size))){supported=false;break;}
            }
            if(supported)return QualitySelector.from(quality);
        }
        return QualitySelector.fromOrderedList(candidates,FallbackStrategy.lowerQualityOrHigherThan(Quality.SD));
    }
    JSONObject diagnostics() throws Exception {
        JSONArray list=new JSONArray();
        for(int i=0;i<routes.size();i++){
            CameraInventory.Route r=routes.get(i);CameraZoomRange z=ranges.get(i);
            list.put(new JSONObject().put("logicalId",r.logicalId).put("physicalId",r.physicalId==null?JSONObject.NULL:r.physicalId)
                .put("min",z.min).put("max",z.max).put("lensMagnification",z.intrinsic).put("rejected",unavailable.contains(i))
                .put("capture",observations.getOrDefault(r.key(),new JSONObject())));
        }
        return new JSONObject().put("appVersion",BuildConfig.VERSION_NAME).put("androidApi",Build.VERSION.SDK_INT).put("mode",videoMode?"video":"photo")
            .put("selected",routes.isEmpty()?JSONObject.NULL:routes.get(selected).key()).put("routes",list).put("discoveryFailures",new JSONObject(discoveryFailures));
    }
    private JSONObject state() throws Exception {
        ZoomState z=camera.getCameraInfo().getZoomState().getValue();
        if(z==null)throw new Exception("Zoom unavailable");
        double min=Double.POSITIVE_INFINITY,max=0;
        for(int i=0;i<ranges.size();i++)if(!unavailable.contains(i)){min=Math.min(min,ranges.get(i).min);max=Math.max(max,ranges.get(i).max);}
        return new JSONObject().put("min",min).put("max",max).put("value",z.getZoomRatio()*ranges.get(selected).intrinsic).put("canSwitch",canSwitch).put("diagnostics",diagnostics());
    }
    private int choose(double value){
        List<CameraZoomRange> allowed=new ArrayList<>();List<Integer> indices=new ArrayList<>();
        for(int i=0;i<ranges.size();i++)if(!unavailable.contains(i)){allowed.add(ranges.get(i));indices.add(i);}
        return indices.get(CameraZoomRange.select(allowed,value));
    }
    void zoom(double value, Reply reply){
        if(camera==null||!Double.isFinite(value)||value<=0){reply.complete(null,"camera_closed");return;}
        int previous=selected,next=choose(value),epoch=generation;
        double previousZoom=camera.getCameraInfo().getZoomState().getValue().getZoomRatio();
        try{
            CompletableFuture<Void> ready=next!=selected?bind(next):CompletableFuture.completedFuture(null);
            ready.whenCompleteAsync((unused,openingError)->{
                if(epoch!=generation){reply.complete(null,"camera_closed");return;}
                if(openingError!=null){recover(previous,next,previousZoom,reply);return;}
                CameraZoomRange range=ranges.get(selected);
                var pending=camera.getCameraControl().setZoomRatio((float)range.local(value));
                pending.addListener(()->{try{pending.get();if(epoch!=generation)throw new Exception("closed");reply.complete(state(),null);}catch(Exception e){if(epoch==generation)recover(previous,next,previousZoom,reply);else reply.complete(null,"camera_closed");}},main);
            },main);
        }catch(Exception e){recover(previous,next,previousZoom,reply);}
    }
    private void recover(int previous,int failed,double zoom,Reply reply){
        final int epoch=generation;
        if(failed!=previous)unavailable.add(failed);
        discoveryFailures.put(routes.get(failed).key(),"capture_or_zoom_failed");
        try{
            bind(previous).whenCompleteAsync((unused,error)->{
                if(epoch!=generation){reply.complete(null,"camera_closed");return;}
                if(error!=null||camera==null){reply.complete(null,"camera_unavailable");return;}
                var pending=camera.getCameraControl().setZoomRatio((float)zoom);
                pending.addListener(()->{try{pending.get();if(epoch!=generation){reply.complete(null,"camera_closed");return;}JSONObject result=state();result.put("warning","Requested camera could not be opened");reply.complete(result,null);}catch(Exception e){reply.complete(null,"zoom_failed");}},main);
            },main);
        }catch(Exception e){reply.complete(null,"camera_unavailable");}
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
    void close(){generation++;bindingEpoch++;if(firstFrame!=null&&!firstFrame.isDone())firstFrame.completeExceptionally(new Exception("Camera closed"));stopRecording();if(provider!=null)provider.unbindAll();camera=null;photos=null;videos=null;preview.setVisibility(View.GONE);}
    void destroy(){close();for(File f:files.values())f.delete();files.clear();}
}

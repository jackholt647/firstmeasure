package ai.firstmeasure.mobile;

import android.hardware.camera2.*;
import android.os.Build;
import java.util.*;
import org.json.*;

final class AndroidCameraInventory implements CameraInventory.Source {
    private final CameraManager manager;
    private List<String> enumerated=List.of();
    private final Map<String,JSONObject> devices=new LinkedHashMap<>();
    JSONObject snapshot() throws Exception{return new JSONObject().put("enumeratedIds",new JSONArray(enumerated)).put("devices",new JSONArray(devices.values()));}
    AndroidCameraInventory(CameraManager manager){this.manager=manager;}
    public List<String> ids() throws Exception{enumerated=Arrays.asList(manager.getCameraIdList());return enumerated;}
    public CameraInventory.Device read(String id) throws Exception {
        CameraCharacteristics c=manager.getCameraCharacteristics(id);
        Integer facing=c.get(CameraCharacteristics.LENS_FACING);
        int[] capabilities=c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        boolean backward=capabilities!=null&&Arrays.stream(capabilities).anyMatch(v->v==CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE);
        var streams=c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        android.util.Size[] privateSizes=streams==null?null:streams.getOutputSizes(android.graphics.ImageFormat.PRIVATE);
        android.util.Size[] yuvSizes=streams==null?null:streams.getOutputSizes(android.graphics.ImageFormat.YUV_420_888);
        boolean color=CameraInventory.supportsPreview(backward,privateSizes==null?0:privateSizes.length,yuvSizes==null?0:yuvSizes.length);
        List<String> children=Build.VERSION.SDK_INT>=28?new ArrayList<>(c.getPhysicalCameraIds()):List.of();
        Collections.sort(children);
        float[] focal=c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
        android.util.SizeF sensor=c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
        android.util.Size pixels=c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE);
        android.graphics.Rect active=c.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
        double width=sensor==null?Double.NaN:sensor.getWidth();
        if(pixels!=null&&active!=null&&pixels.getWidth()>0)width*=((double)active.width())/pixels.getWidth();
        double scale=focal==null||focal.length==0?Double.NaN:focal[0]/width;
        Float digital=c.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM);
        double min=1,max=digital==null?1:digital;
        if(Build.VERSION.SDK_INT>=30){android.util.Range<Float> zoom=c.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE);if(zoom!=null){min=zoom.getLower();max=zoom.getUpper();}}
        devices.put(id,new JSONObject().put("id",id).put("facing",facing).put("physicalIds",new JSONArray(children))
            .put("capabilities",capabilities==null?JSONObject.NULL:new JSONArray(capabilities)).put("backwardCompatible",backward)
            .put("privateOutputSizes",privateSizes==null?0:privateSizes.length).put("yuvOutputSizes",yuvSizes==null?0:yuvSizes.length)
            .put("focalLengths",focal==null?JSONObject.NULL:new JSONArray(focal)).put("sensorWidth",sensor==null?JSONObject.NULL:sensor.getWidth())
            .put("activeWidth",active==null?JSONObject.NULL:active.width()).put("pixelWidth",pixels==null?JSONObject.NULL:pixels.getWidth())
            .put("zoomMin",min).put("zoomMax",max).put("hardwareLevel",c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)));
        return new CameraInventory.Device(id,facing==null?-1:facing,children,scale,min,max,color);
    }
}

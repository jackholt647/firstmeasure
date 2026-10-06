package ai.firstmeasure.mobile;

import android.hardware.camera2.*;
import android.os.Build;
import java.util.*;

final class AndroidCameraInventory implements CameraInventory.Source {
    private final CameraManager manager;
    AndroidCameraInventory(CameraManager manager){this.manager=manager;}
    public List<String> ids() throws Exception{return Arrays.asList(manager.getCameraIdList());}
    public CameraInventory.Device read(String id) throws Exception {
        CameraCharacteristics c=manager.getCameraCharacteristics(id);
        Integer facing=c.get(CameraCharacteristics.LENS_FACING);
        int[] capabilities=c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        boolean color=capabilities!=null&&Arrays.stream(capabilities).anyMatch(v->v==CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE);
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
        return new CameraInventory.Device(id,facing==null?-1:facing,children,scale,min,max,color);
    }
}

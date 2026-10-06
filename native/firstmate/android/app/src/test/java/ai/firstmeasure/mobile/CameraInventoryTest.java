package ai.firstmeasure.mobile;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;
public class CameraInventoryTest {
 private CameraInventory.Device device(String id,int facing,List<String> children,double focal,double max){return new CameraInventory.Device(id,facing,children,focal,1,max,true);}
 @Test public void findsUltrawideAndTelephotoThatAreNotTopLevelDevices() throws Exception {
  var devices=Map.of("rear",device("rear",1,List.of("wide-child","tele-child"),1,10),"selfie",device("selfie",0,List.of(),1,8),"wide-child",device("wide-child",1,List.of(),.5,8),"tele-child",device("tele-child",1,List.of(),3,10));
  List<String> queried=new ArrayList<>();
  var inventory=CameraInventory.discover(new CameraInventory.Source(){public List<String> ids(){return List.of("rear","selfie");}public CameraInventory.Device read(String id){queried.add(id);return devices.get(id);}},1,"rear");
  assertEquals(3,inventory.routes.size());assertTrue(queried.contains("wide-child"));assertTrue(queried.contains("tele-child"));
  var ranges=new ArrayList<CameraZoomRange>();for(var r:inventory.routes)ranges.add(r.range);
  var wide=inventory.routes.get(CameraZoomRange.select(ranges,.5));assertEquals("rear",wide.logicalId);assertEquals("wide-child",wide.physicalId);assertEquals(.5,wide.range.min,.001);
  var tele=inventory.routes.get(CameraZoomRange.select(ranges,30));assertEquals("tele-child",tele.physicalId);assertEquals(30,tele.range.max,.001);
 }
 @Test public void inaccessibleChildIsReportedWithoutLosingWorkingCamera() throws Exception {
  var source=new CameraInventory.Source(){public List<String> ids(){return List.of("main");}public CameraInventory.Device read(String id)throws Exception{if(!id.equals("main"))throw new Exception();return device("main",1,List.of("blocked"),1,10);}};
  var inventory=CameraInventory.discover(source,1,"main");assertEquals(1,inventory.routes.size());assertEquals("physical_characteristics_unavailable",inventory.failures.get("main/blocked"));
 }
 @Test public void noSyntheticHalfZoomWhenHardwareHasOnlyMainCamera() throws Exception {
  var source=new CameraInventory.Source(){public List<String> ids(){return List.of("main");}public CameraInventory.Device read(String id){return device(id,1,List.of(),1,10);}};
  var inventory=CameraInventory.discover(source,1,"main");assertEquals(1,inventory.routes.size());assertEquals(1,inventory.routes.get(0).range.min,0);
 }

 @Test public void previewStreamsDoNotRequireStandaloneBackwardCompatibleFlag(){
  assertTrue(CameraInventory.supportsPreview(false,3,0));assertTrue(CameraInventory.supportsPreview(false,0,2));
  assertFalse(CameraInventory.supportsPreview(false,0,0));assertTrue(CameraInventory.supportsPreview(true,0,0));
 }
 @Test public void excludedParentDoesNotHideItsPhysicalChildren() throws Exception {
  var parent=new CameraInventory.Device("main",1,List.of("wide"),1,1,10,false);
  var wide=device("wide",1,List.of(),.5,8);
  var source=new CameraInventory.Source(){public List<String> ids(){return List.of("main","front");}public CameraInventory.Device read(String id){return id.equals("main")?parent:id.equals("wide")?wide:device("front",0,List.of(),1,4);}};
  var inventory=CameraInventory.discover(source,1,"main");assertEquals(1,inventory.routes.size());assertEquals("wide",inventory.routes.get(0).physicalId);
  assertEquals("no_advertised_preview_output",inventory.exclusions.get("main"));assertEquals("different_facing",inventory.exclusions.get("front"));
 }
}

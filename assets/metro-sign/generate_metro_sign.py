"""Procedural ITinder metro lightbox, Blender 4.4+.

Run: blender --background --python generate_metro_sign.py
Assets are written beside this script; original logo PNG is embedded unchanged.
Dimensions are in metres. Edit PARAMETERS to regenerate the sign.
"""
from pathlib import Path
import math
import json
import bpy
from mathutils import Vector

OUTPUT = Path(__file__).resolve().parent
LOGO = OUTPUT.parent / "branding" / "itinder-logo.png"
PARAMETERS = {
    "width": 3.30,
    "height": 1.065,
    "depth": 0.16,
    "corner_radius": 0.18,
    "frame_border": 0.064,
    "suspension_length": 0.35,
    "suspension_spacing": 2.08,
    "logo_width": 3.18,
    "arc_segments": 32,
}

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for datablocks in (bpy.data.materials, bpy.data.meshes, bpy.data.cameras, bpy.data.lights):
    for block in list(datablocks):
        if block.users == 0:
            datablocks.remove(block)
scene = bpy.context.scene
asset_collection = bpy.data.collections.new("ITinder | exportable sign")
scene.collection.children.link(asset_collection)
environment_collection = bpy.data.collections.new("Render setting | excluded from GLB")
scene.collection.children.link(environment_collection)


def move_to_collection(obj, collection):
    for old in list(obj.users_collection):
        old.objects.unlink(obj)
    collection.objects.link(obj)


def material(name, color, metallic=0.0, roughness=0.4, emission=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Emission Color"].default_value = (*color, 1)
    bsdf.inputs["Emission Strength"].default_value = emission
    mat.diffuse_color = (*color, 1)
    return mat


def aged_metal(name, color):
    mat = material(name, color, 0.86, 0.32)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 86
    noise.inputs["Detail"].default_value = 2
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.2, 0.2, 0.2, 1)
    ramp.color_ramp.elements[1].color = (0.46, 0.46, 0.46, 1)
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], next(n for n in nodes if n.type == "BSDF_PRINCIPLED").inputs["Roughness"])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.11
    bump.inputs["Distance"].default_value = 0.0008
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], next(n for n in nodes if n.type == "BSDF_PRINCIPLED").inputs["Normal"])
    # GLB uses the calibrated base metallic/roughness values; procedural finish
    # remains fully editable in the native .blend file.
    return mat


metal = aged_metal("Dark aged bronze frame", (0.055, 0.041, 0.027))
rear_metal = material("Rear access panel", (0.09, 0.095, 0.10), 0.85, 0.39)
fastener_metal = material("Brushed steel fasteners", (0.32, 0.29, 0.24), 0.91, 0.28)
cream = material("Warm illuminated acrylic", (1.0, 0.855, 0.64), 0, 0.32, 1.8)


def outline(width, height, radius):
    """Counter-clockwise rounded rectangle in the X/Z plane."""
    result = []
    corners = (
        (width / 2 - radius, height / 2 - radius, 0),
        (-width / 2 + radius, height / 2 - radius, 90),
        (-width / 2 + radius, -height / 2 + radius, 180),
        (width / 2 - radius, -height / 2 + radius, 270),
    )
    for cx, cz, start in corners:
        for i in range(PARAMETERS["arc_segments"] + 1):
            angle = math.radians(start + i * 90 / PARAMETERS["arc_segments"])
            result.append((cx + radius * math.cos(angle), cz + radius * math.sin(angle)))
    return result


def mesh_object(name, vertices, faces, mat, collection=asset_collection, bevel=0):
    mesh = bpy.data.meshes.new(name + " geometry")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Manufactured edge radius", "BEVEL")
        mod.width = bevel
        mod.segments = 3
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(20)
        weighted = obj.modifiers.new("Weighted surface normals", "WEIGHTED_NORMAL")
        weighted.keep_sharp = True
    return obj


def rounded_solid(name, width, height, radius, y_front, y_back, mat, bevel=0):
    loop = outline(width, height, radius)
    n = len(loop)
    vertices = [(x, y_front, z) for x, z in loop] + [(x, y_back, z) for x, z in loop]
    faces = [tuple(range(n)), tuple(reversed(range(n, 2*n)))]
    faces += [(i, n+i, n+(i+1) % n, (i+1) % n) for i in range(n)]
    return mesh_object(name, vertices, faces, mat, bevel=bevel)


def rounded_ring(name, outer_w, outer_h, outer_r, inner_w, inner_h, inner_r,
                 y_front, y_back, mat):
    outer = outline(outer_w, outer_h, outer_r)
    inner = outline(inner_w, inner_h, inner_r)
    n = len(outer)
    vertices = [(x, y, z) for y in (y_front, y_back) for loop in (outer, inner) for x, z in loop]
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces += [(i, j, n+j, n+i),
                  (2*n+i, 3*n+i, 3*n+j, 2*n+j),
                  (i, 2*n+i, 2*n+j, j),
                  (n+i, n+j, 3*n+j, 3*n+i)]
    return mesh_object(name, vertices, faces, mat, bevel=0.005)


w, h, d = PARAMETERS["width"], PARAMETERS["height"], PARAMETERS["depth"]
r, b = PARAMETERS["corner_radius"], PARAMETERS["frame_border"]
rounded_solid("01 | cast lightbox housing", w - .01, h - .01, r, -d/2, d/2, metal, .008)
rounded_ring("02 | continuous rounded metal rim", w, h, r, w-2*b, h-2*b, r-b,
             -d/2-.031, -d/2+.012, metal)
rounded_solid("03 | illuminated cream acrylic face", w-2*b+.014, h-2*b+.014,
              r-b+.007, -d/2-.029, -d/2-.005, cream, .005)
rounded_solid("04 | removable rear panel", w-.13, h-.13, r-.064,
              d/2-.004, d/2+.009, rear_metal, .004)


def cylinder(name, radius, depth, location, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=radius, depth=depth,
                                       location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    mod = obj.modifiers.new("Soft machined edges", "BEVEL")
    mod.width = min(.005, radius*.1)
    mod.segments = 3
    obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    move_to_collection(obj, asset_collection)
    return obj


for side, sx in (("left", -PARAMETERS["suspension_spacing"]/2),
                 ("right", PARAMETERS["suspension_spacing"]/2)):
    length = PARAMETERS["suspension_length"]
    cylinder("05 | " + side + " suspension rod", .024, length,
             (sx, .025, h/2 + length/2-.015), metal)
    cylinder("06 | " + side + " collar", .042, .085,
             (sx, .025, h/2+.023), fastener_metal)
    cylinder("07 | " + side + " ceiling mounting plate", .113, .021,
             (sx, .025, h/2+length-.019), metal)
    for dx in (-.065, .065):
        cylinder("08 | " + side + " mounting screw", .008, .009,
                 (sx+dx, .025, h/2+length-.034), fastener_metal)

# Original artwork is placed on the acrylic as an alpha decal. No image edits.
logo_img = bpy.data.images.load(str(LOGO), check_existing=True)
logo_img.name = "ITinder original logo | unchanged PNG"
logo_img.pack()
aspect = logo_img.size[0] / logo_img.size[1]
lw, lh = PARAMETERS["logo_width"], PARAMETERS["logo_width"]/aspect
vertices = [(-lw/2, -d/2-.034, -lh/2), (lw/2, -d/2-.034, -lh/2),
            (lw/2, -d/2-.034, lh/2), (-lw/2, -d/2-.034, lh/2)]
logo_mat = bpy.data.materials.new("ITinder printed logo | original RGBA")
logo_mat.use_nodes = True
logo_mat.surface_render_method = "DITHERED"
logo_mat.use_transparent_shadow = False
nodes, links = logo_mat.node_tree.nodes, logo_mat.node_tree.links
bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = .66
bsdf.inputs["Specular IOR Level"].default_value = .2
bsdf.inputs["Emission Strength"].default_value = .1
tex = nodes.new("ShaderNodeTexImage")
tex.name = "UNCHANGED original ITinder artwork"
tex.image = logo_img
tex.interpolation = "Linear"
tex.extension = "CLIP"
links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
logo_obj = mesh_object("09 | original ITinder logo decal", vertices, [(0,1,2,3)], logo_mat)
uv = logo_obj.data.uv_layers.new(name="Logo UV")
for li, coord in enumerate(((0,0), (1,0), (1,1), (0,1))):
    uv.data[li].uv = coord

# Rear service fasteners, flush with the removable panel.
for sx in (-w/2+.19, w/2-.19):
    for sz in (-h/2+.18, h/2-.18):
        cylinder("10 | rear panel screw", .011, .009,
                 (sx, d/2+.011, sz), fastener_metal, (math.pi/2,0,0))

root = bpy.data.objects.new("ITinder metro lightbox | procedural", None)
asset_collection.objects.link(root)
root["design"] = "Rounded metro lightbox with original ITinder artwork"
root["dimensions_metres"] = json.dumps(PARAMETERS)
root["logo_source"] = str(LOGO)
for obj in list(asset_collection.objects):
    if obj != root:
        obj.parent = root

# Separate station-inspired render scene, intentionally excluded from the GLB.
def cube(name, location, scale, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    move_to_collection(obj, environment_collection)
    return obj

stone = material("Station stone", (.12,.075,.045), 0, .5)
snodes, slinks = stone.node_tree.nodes, stone.node_tree.links
noise = snodes.new("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = 4.5
noise.inputs["Detail"].default_value = 5
noise.inputs["Roughness"].default_value = .7
texcoord = snodes.new("ShaderNodeTexCoord")
mapping = snodes.new("ShaderNodeMapping")
mapping.inputs["Scale"].default_value = (1.2,1.2,8)
slinks.new(texcoord.outputs["Generated"], mapping.inputs["Vector"])
slinks.new(mapping.outputs["Vector"], noise.inputs["Vector"])
ramp = snodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].position = .28
ramp.color_ramp.elements[0].color = (.025,.016,.012,1)
ramp.color_ramp.elements[1].position = .72
ramp.color_ramp.elements[1].color = (.20,.11,.065,1)
slinks.new(noise.outputs["Fac"], ramp.inputs["Fac"])
slinks.new(ramp.outputs["Color"], next(n for n in snodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"])
stone_light = material("Station upper plaster", (.29,.24,.18), 0, .76)
ceiling = material("Warm dark ceiling", (.045,.029,.019), 0, .76)
for ix in range(-5,6):
    cube("Station stone slab", (ix*.68, .97, -.96), (.674,.18,1.32), stone)
cube("Station upper wall", (0,1.04,.94), (9,.22,2.15), stone_light)
cube("Station ceiling", (0,.28,h/2+PARAMETERS["suspension_length"]+.01), (10,8,.14), ceiling)

def area_light(name, location, energy, color, size, target):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.color, data.shape, data.size = energy, color, "DISK", size
    obj = bpy.data.objects.new(name, data)
    environment_collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector(target)-obj.location).to_track_quat("-Z","Y").to_euler()
    return obj

area_light("Warm softbox", (-3,-4,4), 650, (1.0,.79,.56), 4, (0,0,.2))
area_light("Gentle blue fill", (4,-3,1), 210, (.78,.84,1), 3, (0,0,.1))
area_light("Lightbox spill onto ceiling", (0,-.04,.62), 38, (1,.72,.43), 2.2, (0,.4,1.5))
area_light("Station background light", (-2,.4,1.2), 85, (1,.71,.46), 2, (0,1,-.9))
world = bpy.data.worlds.new("Low station ambience")
world.use_nodes = True
next(n for n in world.node_tree.nodes if n.type == "BACKGROUND").inputs[0].default_value = (.11,.085,.065,1)
next(n for n in world.node_tree.nodes if n.type == "BACKGROUND").inputs[1].default_value = .35
scene.world = world

camera_data = bpy.data.cameras.new("Metro sign hero camera")
camera = bpy.data.objects.new("Metro sign hero camera", camera_data)
environment_collection.objects.link(camera)
camera.location = (-3.2,-6.5,-.60)
target = Vector((0,0,.15))
camera.rotation_euler = (target-camera.location).to_track_quat("-Z","Y").to_euler()
camera_data.lens = 56
scene.camera = camera
scene.render.engine = "CYCLES"
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.render.resolution_x = 1200
scene.render.resolution_y = 800
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(OUTPUT / "itinder-metro-sign-model-preview.png")
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"

# Selection-only export packs the original logo PNG into the GLB.
bpy.ops.object.select_all(action="DESELECT")
for obj in asset_collection.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = root
bpy.ops.export_scene.gltf(filepath=str(OUTPUT / "itinder-metro-sign.glb"),
                          export_format="GLB", use_selection=True,
                          export_apply=True, export_materials="EXPORT",
                          export_image_format="AUTO", export_extras=True)
bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT / "itinder-metro-sign.blend"))
bpy.ops.render.render(write_still=True)
metadata = {"parameters": PARAMETERS, "logo": str(LOGO),
            "render": "Procedural Blender geometry with unchanged original logo texture",
            "export": "Sign, two suspension rods, mounting plates; station setting omitted",
            "units": "metres", "axis": "glTF Y-up (converted from Blender Z-up)"}
(OUTPUT / "model-metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
print("ITINDER_MODEL_COMPLETE", str(OUTPUT))
